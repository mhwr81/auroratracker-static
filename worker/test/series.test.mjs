/**
 * Tests for the solar wind series state.
 *
 * The thing worth protecting here is the app's view. ApiService intercepts
 * the bundle in _fetchRtswActiveRecords and hands the rows straight to
 * _filterRtswByPeriod and the chart builders, which were written against raw
 * RTSW records. So a row produced by the 3-minute propagated feed and a row
 * produced by the hourly RTSW repair have to be INDISTINGUISHABLE — same
 * keys, same time_tag spelling, same types. Most of what follows is pinning
 * that down.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAG_FIELDS,
  WIND_FIELDS,
  SERIES_WINDOW_MS,
  bareTag,
  toIsoZ,
  applyDensity,
  mergeSeries,
  projectRow,
  rebuildSeries,
  fetchPropagated,
  appendSeries,
  leavesGap,
  sliceFrom,
  propagatedRows,
  writeSeriesState,
  readSeriesState,
  readTail,
  writeTail,
  since,
} from "../src/series.js";
import { repairDue, assembleLive, assembleNow, publishable, liveBody, seriesBody } from "../src/index.js";

const NOW = Date.parse("2026-09-16T12:00:00Z");

/** A bare RTSW-style time_tag `n` minutes before NOW. */
const ago = (n) => new Date(NOW - n * 60_000).toISOString().replace(/\.\d{3}Z$/, "");

const magRow = (n, bz = 1) => ({ time_tag: ago(n), bz_gsm: bz, bt: 5, bx_gsm: 0, by_gsm: 0 });

// ── time_tag spelling ──────────────────────────────────────────────────────

test("time_tag is normalised to the bare RTSW spelling", () => {
  assert.equal(bareTag("2026-09-16T12:00:00Z"), "2026-09-16T12:00:00");
  assert.equal(bareTag("2026-09-16T12:00:00"), "2026-09-16T12:00:00");
  assert.equal(bareTag(null), null);
});

test("toIsoZ round-trips back to a parseable instant", () => {
  assert.equal(toIsoZ("2026-09-16T12:00:00"), "2026-09-16T12:00:00Z");
  assert.equal(toIsoZ("2026-09-16T12:00:00Z"), "2026-09-16T12:00:00Z");
  assert.equal(Date.parse(toIsoZ(bareTag("2026-09-16T12:00:00Z"))), NOW);
});

test("the two feeds' spellings collide rather than duplicating", () => {
  // The propagated feed says `...:00Z`, RTSW says `...:00`. If these did not
  // key together the chart would carry two points a minute apart.
  const fromRtsw = [{ time_tag: "2026-09-16T11:59:00", bz_gsm: 1 }];
  const fromPropagated = [{ time_tag: "2026-09-16T11:59:00Z", bz_gsm: 2 }];
  const merged = mergeSeries(fromRtsw, fromPropagated, NOW);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].bz_gsm, 2);
  assert.equal(merged[0].time_tag, "2026-09-16T11:59:00");
});

// ── density policy ─────────────────────────────────────────────────────────

test("everything in the last 6 hours is kept at full rate", () => {
  const rows = [];
  for (let n = 300; n >= 0; n--) rows.push(magRow(n));
  assert.equal(applyDensity(rows, NOW).length, 301);
});

test("beyond 6 hours it thins to one sample per 10 minutes", () => {
  const rows = [];
  for (let n = 720; n >= 600; n--) rows.push(magRow(n)); // 12h..10h ago, 1-min
  const out = applyDensity(rows, NOW);
  // 121 minutes of 1-minute data -> ~13 samples at 10-minute spacing.
  assert.ok(out.length >= 12 && out.length <= 14, `got ${out.length}`);
  for (let i = 1; i < out.length; i++) {
    const gap = Date.parse(toIsoZ(out[i].time_tag)) - Date.parse(toIsoZ(out[i - 1].time_tag));
    assert.ok(gap >= 10 * 60_000, `gap ${gap}ms below 10 minutes`);
  }
});

test("rows older than the window are dropped", () => {
  const old = magRow(SERIES_WINDOW_MS / 60_000 + 60); // an hour past the edge
  const fresh = magRow(5);
  const out = applyDensity([old, fresh], NOW);
  assert.deepEqual(out.map((r) => r.time_tag), [fresh.time_tag]);
});

test("thinning is idempotent, because it now runs on its own output", () => {
  // The old code thinned raw records once. This runs every tick on state
  // that is already thinned, and rows cross the 6-hour boundary as they age.
  const rows = [];
  for (let n = 1400; n >= 0; n--) rows.push(magRow(n));
  const once = applyDensity(rows, NOW);
  const twice = applyDensity(once, NOW);
  assert.deepEqual(twice, once);
});

// ── merge ──────────────────────────────────────────────────────────────────

test("a restated row is replaced by the fresher value, not duplicated", () => {
  const prev = [magRow(10, 1), magRow(9, 1)];
  const fresh = [magRow(9, 99)];
  const out = mergeSeries(prev, fresh, NOW);
  assert.equal(out.length, 2);
  assert.equal(out.at(-1).bz_gsm, 99);
});

test("merge returns rows oldest to newest", () => {
  const out = mergeSeries([magRow(1), magRow(30)], [magRow(15)], NOW);
  assert.deepEqual(
    out.map((r) => r.time_tag),
    [ago(30), ago(15), ago(1)]
  );
});

test("merge tolerates missing or malformed state", () => {
  assert.deepEqual(mergeSeries(null, [], NOW), []);
  assert.deepEqual(mergeSeries(undefined, undefined, NOW), []);
  assert.equal(mergeSeries([{ time_tag: null }, magRow(1)], [], NOW).length, 1);
});

// ── projection ─────────────────────────────────────────────────────────────

test("projection keeps the app's fields and drops nulls", () => {
  const row = projectRow(
    { time_tag: ago(1), bz_gsm: 1.5, bt: null, bx_gsm: 0, by_gsm: undefined, source: "SOLAR1", junk: 1 },
    MAG_FIELDS
  );
  assert.deepEqual(row, { time_tag: ago(1), bz_gsm: 1.5, bx_gsm: 0, source: "SOLAR1" });
  assert.ok(!("junk" in row), "unrelated RTSW fields must not be published");
});

test("rebuild matches a merge from empty, but thins before projecting", () => {
  const records = [];
  for (let n = 1400; n >= 0; n--) records.push({ ...magRow(n), source: "SOLAR1", junk: n });
  const viaRebuild = rebuildSeries(records, MAG_FIELDS, NOW, "SOLAR1");
  const viaMerge = mergeSeries([], records.map((r) => projectRow(r, MAG_FIELDS)), NOW);
  assert.deepEqual(viaRebuild, viaMerge);
});

test("rebuild backfills source but never overwrites the record's own", () => {
  const rows = rebuildSeries(
    [{ ...magRow(1), source: "DSCOVR" }, magRow(2)],
    MAG_FIELDS,
    NOW,
    "SOLAR1"
  );
  assert.equal(rows.find((r) => r.time_tag === ago(1)).source, "DSCOVR");
  assert.equal(rows.find((r) => r.time_tag === ago(2)).source, "SOLAR1");
});

// ── the propagated feed ────────────────────────────────────────────────────

test("propagated columns are resolved by name, not position", async () => {
  // Same data, columns shuffled. Reading by index would silently publish bx
  // as bz -- plausible numbers, wrong frame, invisible on a chart.
  const table = [
    ["bt", "time_tag", "density", "bz", "speed", "bx", "by", "temperature"],
    [5.94, "2026-09-16T11:59:00Z", 5.8, 3.98, 520.5, 3.02, -3.21, 160452],
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => table });

  const { mag, wind, latestMag, latestWind } = await fetchPropagated("SOLAR1");
  assert.deepEqual(mag[0], {
    time_tag: "2026-09-16T11:59:00",
    bz_gsm: 3.98,
    bt: 5.94,
    bx_gsm: 3.02,
    by_gsm: -3.21,
    source: "SOLAR1",
  });
  assert.deepEqual(wind[0], {
    time_tag: "2026-09-16T11:59:00",
    proton_speed: 520.5,
    proton_density: 5.8,
    proton_temperature: 160452,
    source: "SOLAR1",
  });
  assert.equal(latestMag.bz_gsm, 3.98);
  assert.equal(latestWind.proton_speed, 520.5);
});

test("a propagated row and an RTSW row produce the same shape", async () => {
  // The guarantee the app depends on: it cannot tell which tier wrote a row.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      ["time_tag", "speed", "density", "temperature", "bx", "by", "bz", "bt"],
      ["2026-09-16T11:59:00Z", 520.5, 5.8, 160452, 3.02, -3.21, 3.98, 5.94],
    ],
  });
  const { mag: fromFast } = await fetchPropagated("SOLAR1");
  const fromRepair = rebuildSeries(
    [{
      time_tag: "2026-09-16T11:59:00", active: true, source: "SOLAR1",
      bz_gsm: 3.98, bt: 5.94, bx_gsm: 3.02, by_gsm: -3.21,
      bz_gse: 1.88, overall_quality: 0, sample_size: 60,
    }],
    MAG_FIELDS, NOW, "SOLAR1"
  );
  assert.deepEqual(Object.keys(fromFast[0]).sort(), Object.keys(fromRepair[0]).sort());
  assert.deepEqual(fromFast[0], fromRepair[0]);
});

test("a missing column is an error, not a silent null series", async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => [["time_tag", "speed"], ["2026-09-16T11:59:00Z", 520.5]],
  });
  // Whichever column it notices first — the point is that it throws rather
  // than publishing a series of undefineds.
  await assert.rejects(() => fetchPropagated(), /missing column/);
});

// ── scheduling + publish gate ──────────────────────────────────────────────

test("the repair tier rebuilds on a gap or after 12 h, and reads RTSW daily", () => {
  const iso = (hAgo) => new Date(NOW - hAgo * 3600_000).toISOString();
  assert.equal(repairDue(null, NOW), "rebuild"); // no state at all
  assert.equal(repairDue({ repaired_at: null, source_at: null, gap_at: null }, NOW), "rebuild");
  assert.equal(repairDue({ repaired_at: iso(1), source_at: iso(1), gap_at: iso(0.1) }, NOW), "rebuild");
  assert.equal(repairDue({ repaired_at: iso(13), source_at: iso(1), gap_at: null }, NOW), "rebuild");
  assert.equal(repairDue({ repaired_at: iso(1), source_at: iso(25), gap_at: null }, NOW), "rtsw");
  assert.equal(repairDue({ repaired_at: iso(1), source_at: iso(1), gap_at: null }, NOW), null);
  assert.equal(repairDue({ repaired_at: "garbage", source_at: iso(1), gap_at: null }, NOW), "rebuild");
});

// ── the fast tier's shortcuts must not change the answer ───────────────────

/** applyDensity as it was before the string-compare shortcut. */
function applyDensityReference(rows, nowMs) {
  const out = [];
  let lastCoarse = 0;
  for (const r of rows) {
    const t = Date.parse(toIsoZ(r?.time_tag));
    if (Number.isNaN(t)) continue;
    if (nowMs - t > SERIES_WINDOW_MS) continue;
    if (nowMs - t > 6 * 3600_000) {
      if (t - lastCoarse < 10 * 60_000) continue;
      lastCoarse = t;
    }
    out.push(r);
  }
  return out;
}

test("density's string shortcut matches the Date.parse version, boundaries included", () => {
  const rows = [];
  for (let n = 26 * 60; n >= 0; n--) rows.push(magRow(n));
  rows.push({ time_tag: "not a time" }, { time_tag: ago(5) + "Z" });
  // Whole-minute, whole-second and fractional "now", so the cutoffs land on,
  // just after and between rows.
  for (const now of [NOW, NOW + 1, NOW + 999, NOW + 1000, NOW + 30_500, NOW - 1]) {
    assert.deepEqual(applyDensity(rows, now), applyDensityReference(rows, now), `now=${now}`);
  }
});

test("appendSeries gives the same series as mergeSeries, tick after tick", () => {
  // A day of history, then 3 hours of 2-minute ticks each carrying the last
  // hour -- including restated values -- exactly as the fast tier sees them.
  const feed = (end) => {
    const out = [];
    for (let m = 60; m >= 0; m--) {
      const t = new Date(end - m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      out.push({ time_tag: t, bz_gsm: (end / 60_000 + m) % 7, bt: 5, source: "SOLAR1" });
    }
    return out;
  };
  let a = mergeSeries([], Array.from({ length: 1440 }, (_, i) => magRow(1440 - i)), NOW);
  let b = a;
  for (let tick = 0; tick < 90; tick++) {
    const now = NOW + tick * 120_000 + 17_000;
    const fresh = feed(now - 17_000);
    a = mergeSeries(a, fresh, now);
    b = appendSeries(b, fresh, now);
    assert.deepEqual(b, a, `tick ${tick}`);
  }
});

test("a hole between the stored series and the fresh hour is a gap", () => {
  const prev = [magRow(120), magRow(90)];
  assert.equal(leavesGap(prev, [{ time_tag: ago(89) + "Z" }]), false);
  assert.equal(leavesGap(prev, [{ time_tag: ago(95) + "Z" }]), false); // overlap
  assert.equal(leavesGap(prev, [{ time_tag: ago(60) + "Z" }]), true);
  assert.equal(leavesGap([], [{ time_tag: ago(60) }]), false);
});

test("liveBody is byte-for-byte JSON.stringify(live)", () => {
  const state = {
    mag: [magRow(2), magRow(1)], wind: [{ time_tag: ago(1), proton_speed: 400 }], hemi: [],
    source: "SOLAR1", hemi_latest: { north: 1, south: 2 },
    latest: { bz: 1, speed: 400, mag_time: toIsoZ(ago(1)), wind_time: toIsoZ(ago(1)) },
  };
  const live = assembleLive(state);
  assert.equal(liveBody(live), JSON.stringify(live));
  const json = { mag: JSON.stringify(state.mag), wind: JSON.stringify(state.wind), hemi: "[]" };
  assert.equal(liveBody(live, json), JSON.stringify(live));
});

// ── the repair feed ────────────────────────────────────────────────────────

const H = ["time_tag", "speed", "density", "temperature", "bx", "by", "bz", "bt", "vx", "vy", "vz", "propagated_time_tag"];
const fullTable = (hours) => {
  const t = [H];
  for (let m = hours * 60; m >= 0; m--) {
    const tag = ago(m) + "Z";
    t.push([tag, 400 + m, 5, 1e5, 1, 2, (m % 9) - 4, 6, -400, 0, 0, tag]);
  }
  return t;
};

test("sliceFrom parses only the tail, and returns what a full parse would", () => {
  const table = fullTable(72);
  // NOAA's layout: one row per line.
  const text = "[" + table.map((r) => JSON.stringify(r)).join(",\n") + "]";
  const cutoff = NOW - SERIES_WINDOW_MS;
  const { header, rows } = sliceFrom(text, cutoff);
  assert.deepEqual(header, H);
  assert.ok(rows.length < 26 * 60 && rows.length >= 24 * 60, `rows=${rows.length}`);
  const full = table.slice(1).filter((r) => r[0] >= rows[0][0]);
  assert.deepEqual(rows, full);
  // Rebuilt series are identical whichever way the table was read.
  const viaSlice = propagatedRows(header, rows, "SOLAR1");
  const viaFull = propagatedRows(table[0], table.slice(1), "SOLAR1");
  assert.deepEqual(rebuildSeries(viaSlice.mag, MAG_FIELDS, NOW), rebuildSeries(viaFull.mag, MAG_FIELDS, NOW));
  assert.deepEqual(rebuildSeries(viaSlice.wind, WIND_FIELDS, NOW), rebuildSeries(viaFull.wind, WIND_FIELDS, NOW));
});

test("sliceFrom falls back to a full parse when the cutoff hour is missing", () => {
  const table = [H, [ago(5) + "Z", 400, 5, 1e5, 1, 2, -3, 6, 0, 0, 0, null]];
  const { rows } = sliceFrom(JSON.stringify(table), NOW - SERIES_WINDOW_MS);
  assert.deepEqual(rows, table.slice(1));
});

const memBucket = () => {
  const objs = new Map();
  return {
    objs,
    async put(k, body) { objs.set(k, body); },
    async get(k) { const o = objs.get(k); return o === undefined ? null : { json: async () => JSON.parse(o), text: async () => o }; },
  };
};

test("state and tail round-trip, including the repair bookkeeping", async () => {
  const bucket = memBucket();
  const state = { mag: [magRow(1)], wind: [], latest: { bz: 1 }, source: "SOLAR1", repaired_at: "2026-09-16T00:00:00.000Z", source_at: null, gap_at: null };
  await writeSeriesState(bucket, state, { mag: JSON.stringify(state.mag) });
  const back = await readSeriesState(bucket);
  assert.deepEqual({ ...back, cold: undefined }, { ...state, cold: undefined });

  const tail = { mag: [magRow(1)], wind: [], hemi: [{ time: "2026-09-16T12:30:00Z", north: 1, south: 2 }], latest: { bz: 1 }, hemi_latest: null, source: "SOLAR1", gap_at: null };
  await writeTail(bucket, tail, { mag: JSON.stringify(tail.mag) });
  assert.deepEqual({ ...(await readTail(bucket)), cold: undefined }, { ...tail, cold: undefined });
  assert.equal((await readTail(memBucket())).cold, true);
});

test("since keeps rows at or after the cutoff, for both key spellings", () => {
  const rows = [magRow(130), magRow(120), magRow(60), magRow(1)];
  assert.deepEqual(since(rows, NOW - 120 * 60_000), rows.slice(1));
  const hemi = [{ time: toIsoZ(ago(200)) }, { time: toIsoZ(ago(100)) }, { time: toIsoZ(ago(-30)) }];
  assert.deepEqual(since(hemi, NOW - 120 * 60_000, "time"), hemi.slice(1));
  assert.deepEqual(since([], NOW), []);
});

test("v2/now.json carries v1's readings, with the tail in place of the series", () => {
  const tail = {
    mag: [magRow(1)], wind: [], hemi: [], source: "SOLAR1", hemi_latest: { north: 1, south: 2 },
    latest: { bz: 1, speed: 400, mag_time: new Date().toISOString(), wind_time: new Date().toISOString() },
  };
  const v1 = assembleLive(tail);
  const now = assembleNow(tail);
  assert.equal(now.schema, "v2");
  assert.deepEqual(now.solar_wind, v1.solar_wind);
  assert.deepEqual(now.hemispheric_power, v1.hemispheric_power);
  assert.deepEqual(now.tail, v1.series);
  assert.equal(now.series, undefined);
  assert.equal(publishable(now), null);
});

test("v2/series.json is valid JSON with null for empty series", () => {
  const view = { mag: [magRow(2), magRow(1)], wind: [], hemi: [] };
  const doc = JSON.parse(seriesBody(view, { mag: JSON.stringify(view.mag) }));
  assert.equal(doc.schema, "v2");
  assert.deepEqual(doc.series, { mag: view.mag, wind: null, hemi: null });
});

test("a bundle without bz or speed is refused, keeping the last good one", () => {
  const state = { mag: [], wind: [], hemi: [], source: null, hemi_latest: null, latest: {} };
  assert.equal(publishable(assembleLive(state)), "bz or speed missing");

  const good = {
    ...state,
    latest: { bz: 1, speed: 400, mag_time: new Date().toISOString(), wind_time: new Date().toISOString() },
  };
  assert.equal(publishable(assembleLive(good)), null);
});

test("stale data is refused even when every field is present", () => {
  const old = new Date(Date.now() - 4 * 3600_000).toISOString();
  const live = assembleLive({
    mag: [], wind: [], hemi: [], source: null, hemi_latest: null,
    latest: { bz: 1, speed: 400, mag_time: old, wind_time: old },
  });
  assert.match(publishable(live), /^data \d+m old$/);
});

test("empty series publish as null, not as []", () => {
  // ApiService treats an empty bundle series as "go and fetch RTSW yourself".
  // Publishing [] instead of null would satisfy its `isNotEmpty` check on the
  // wrong side and leave the chart blank instead of falling back.
  const live = assembleLive({
    mag: [], wind: [], hemi: [], source: null, hemi_latest: null,
    latest: { bz: 1, speed: 400, mag_time: new Date().toISOString(), wind_time: new Date().toISOString() },
  });
  assert.equal(live.series.mag, null);
  assert.equal(live.series.wind, null);
  assert.equal(live.series.hemi, null);
});
