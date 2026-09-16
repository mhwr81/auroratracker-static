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
} from "../src/series.js";
import { repairTarget, assembleLive, publishable } from "../src/index.js";

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

test("the repair tier alternates feeds across the hour", () => {
  assert.equal(repairTarget(new Date(Date.UTC(2026, 8, 16, 12, 5))), "mag");
  assert.equal(repairTarget(new Date(Date.UTC(2026, 8, 16, 12, 35))), "wind");
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
