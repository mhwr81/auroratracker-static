/**
 * Solar wind series state, and the cheap feed that keeps its recent end live.
 *
 * Why this exists
 * ---------------
 * The live tier used to rebuild the mag and wind series from scratch every 3
 * minutes by reading both RTSW files in full. That is 4.0 MB, and V8 spends
 * ~5.6 ms just in JSON.parse getting through it — measured 2.67 ms for
 * rtsw_mag_1m (1.46 MB) and 2.91 ms for rtsw_wind_1m (2.57 MB). The free
 * plan allows 10 ms of CPU per invocation for the WHOLE tick, so the parse
 * alone ate most of the budget and the Worker was dying with `exceededCpu`.
 *
 * So the series became state instead of a recomputation, on two speeds:
 *
 *   fast (every 3 min)   propagated-solar-wind-1-hour.json — 6,575 bytes,
 *                        0.02 ms to parse — appended to the dense end.
 *   repair (hourly)      the full RTSW file for ONE feed, replacing that
 *                        feed's series wholesale.
 *
 * The repair tier is what keeps this honest: the series is still derived
 * from the authoritative feed, just not every tick, so a gap or a bad row
 * cannot persist beyond an hour and this never becomes append-only state
 * that drifts away from NOAA with no way back.
 *
 * On trusting the propagated feed
 * -------------------------------
 * It carries the SAME MEASUREMENTS, not a re-derivation. Checked against
 * RTSW on overlapping time_tags: bz 37/37 exact, bt 37/37, speed 40/40,
 * density 40/40, temperature exact. Full precision — this is not the
 * /products/summary/ problem, where bz -1.08 comes back rounded to -1.
 *
 * Its `bx`/`by` are GSM: 54/54 matched bx_gsm/by_gsm and 0/54 matched the
 * GSE pair, which is the frame MAG_FIELDS wants. Columns are resolved BY
 * NAME below rather than by index, because getting that pairing wrong would
 * publish plausible numbers in the wrong frame — a failure nobody would spot
 * on a chart.
 *
 * Its `time_tag` is the L1 observation time, the same clock RTSW stamps, so
 * rows from the two sources key against each other directly.
 * `propagated_time_tag` is a separate Earth-arrival estimate and is ignored.
 */

const PROPAGATED_URL =
  "https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind-1-hour.json";

const UA = { "User-Agent": "AuroraTracker/1.0 (+https://auroratracker.app)" };
const TIMEOUT_MS = 15000;

/**
 * Working state, kept separate from the published v1/live.json.
 *
 * Separate because the two have different lifetimes. `publishable()` refuses
 * to write live.json when bz or speed is missing, which is correct for the
 * public file — but when state lived inside it, a refusal also froze the
 * rolling window, so a feed hiccup stopped the series advancing as well as
 * stopping the publish. State now advances whether or not the tick produced
 * something publishable.
 */
export const STATE_KEY = "internal/series.json";

/**
 * How much solar wind history the series carries.
 *
 * 24 hours because that is all RTSW has ever held — measured span on a
 * representative run was 2026-09-15T16:42 to 2026-09-16T16:38. The app knows
 * this (see ApiService._fetchRtswActiveRecords) and its 3-day view has
 * always drawn a day. Keeping the same window means the repair tier can
 * still replace a feed's series wholesale from one RTSW read.
 */
export const SERIES_WINDOW_MS = 24 * 3600_000;

/** Full 1-minute resolution for recent data, thinned before that. */
const DENSE_MS = 6 * 3600_000;
const COARSE_MS = 10 * 60_000;

export const MAG_FIELDS = ["bz_gsm", "bt", "bx_gsm", "by_gsm", "source"];
export const WIND_FIELDS = ["proton_speed", "proton_density", "proton_temperature", "source"];

// ── time ───────────────────────────────────────────────────────────────────

/**
 * RTSW stamps `2026-09-14T01:59:00` with no zone; the propagated feed stamps
 * the same instant as `...:00Z`. Series rows are normalised to the bare RTSW
 * form so a row's identity does not depend on which tier wrote it — rows
 * from the two sources have to collide in the merge map, not sit beside each
 * other as near-duplicates a minute apart on the chart.
 */
export function bareTag(timeTag) {
  if (timeTag === null || timeTag === undefined) return null;
  const s = String(timeTag);
  return s.endsWith("Z") ? s.slice(0, -1) : s;
}

/** The same value as a parseable instant. RTSW's bare form is always UTC. */
export function toIsoZ(timeTag) {
  if (timeTag === null || timeTag === undefined) return null;
  const s = String(timeTag);
  return s.endsWith("Z") ? s : s + "Z";
}

function tagMs(timeTag) {
  const iso = toIsoZ(timeTag);
  if (!iso) return NaN;
  return Date.parse(iso);
}

// ── density + merge ────────────────────────────────────────────────────────

/**
 * Thin a series to what a chart can draw: everything in the last 6 hours,
 * one sample per 10 minutes before that.
 *
 * The app offers 2h, 6h, 12h, 1d and 3d views and filters client-side from a
 * single array, so one fixed resolution cannot serve all of them — coarse
 * enough for the long views leaves the 2-hour view with a dozen points.
 * _filterRtswByPeriod trims from the newest end, so a short window lands
 * entirely inside the dense part.
 *
 * Selection is by timestamp, not index, so a gap in the feed does not shift
 * the boundary. It is also idempotent, which matters now that it runs on
 * already-thinned state every tick rather than on raw records once: rows
 * that were dense when written get thinned as they age past 6 hours, and
 * re-thinning something already 10 minutes apart leaves it alone.
 */
export function applyDensity(rows, nowMs) {
  const out = [];
  let lastCoarse = 0;

  for (const r of rows) {
    const t = tagMs(r?.time_tag);
    if (Number.isNaN(t)) continue;
    if (nowMs - t > SERIES_WINDOW_MS) continue;

    if (nowMs - t > DENSE_MS) {
      if (t - lastCoarse < COARSE_MS) continue;
      lastCoarse = t;
    }
    out.push(r);
  }
  return out;
}

/**
 * Fold fresh rows into a stored series, newest write winning on a collision,
 * then re-apply the density policy and the window.
 *
 * Fresh wins because a row can legitimately be restated: RTSW revises a
 * minute as late telemetry arrives, and the repair tier's version of a row
 * is by definition the better answer than the fast tier's.
 */
export function mergeSeries(prev, fresh, nowMs) {
  const byTime = new Map();
  for (const r of Array.isArray(prev) ? prev : []) {
    const tag = bareTag(r?.time_tag);
    if (tag !== null) byTime.set(tag, { ...r, time_tag: tag });
  }
  for (const r of Array.isArray(fresh) ? fresh : []) {
    const tag = bareTag(r?.time_tag);
    if (tag !== null) byTime.set(tag, { ...r, time_tag: tag });
  }

  // Plain < > rather than localeCompare: these are fixed-width ISO strings,
  // so byte order IS chronological order, and collation buys nothing.
  const sorted = [...byTime.values()].sort((a, b) =>
    a.time_tag < b.time_tag ? -1 : a.time_tag > b.time_tag ? 1 : 0
  );
  return applyDensity(sorted, nowMs);
}

/** Keep only the fields the app reads, dropping nulls as the old path did. */
export function projectRow(record, fields) {
  const row = { time_tag: bareTag(record.time_tag) };
  for (const f of fields) {
    const v = record[f];
    if (v !== null && v !== undefined) row[f] = v;
  }
  return row;
}

/**
 * Rebuild a series from raw RTSW records, for the repair tier.
 *
 * Deliberately NOT mergeSeries(prev=[], ...). Two things are skipped that a
 * merge cannot skip, and on 1,429 records both show up on a 10 ms budget:
 *
 *   - No Map and no sort. activeRecords already returned these sorted and
 *     one-per-minute, so building a 1,429-entry map to dedup and re-sorting
 *     an already-sorted array is pure overhead.
 *   - Thin BEFORE projecting. The window keeps ~440 of 1,429 rows, so
 *     projecting first allocated roughly a thousand objects to throw away.
 *
 * Measured together: repair drops from ~7.5 ms to comfortably inside budget.
 */
export function rebuildSeries(records, fields, nowMs, source = null) {
  const kept = applyDensity(records, nowMs);
  const out = new Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    // Project first, then backfill source — spreading the raw record to add
    // it would copy all 24 RTSW fields just to read four of them back out.
    const row = projectRow(kept[i], fields);
    if (source !== null && row.source === undefined) row.source = source;
    out[i] = row;
  }
  return out;
}

// ── the fast feed ──────────────────────────────────────────────────────────

/**
 * The last hour of solar wind, as mag-shaped and wind-shaped rows.
 *
 * `source` is not in this feed — it is the satellite id (SOLAR1), which the
 * repair tier reads off RTSW and parks in state. It is stamped onto these
 * rows so every row in the published series carries the same shape whichever
 * tier wrote it; the app reads point['source'] per row when building chart
 * series and would otherwise see it appear and disappear along the x-axis.
 */
export async function fetchPropagated(source = null) {
  const res = await fetch(PROPAGATED_URL, {
    headers: { ...UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`propagated -> HTTP ${res.status}`);

  const table = await res.json();
  if (!Array.isArray(table) || table.length < 2) {
    throw new Error("propagated feed carried no rows");
  }

  // By name, not by position — see the header note on the GSM frame.
  const header = table[0].map((h) => String(h).trim());
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`propagated feed missing column ${name}`);
    return i;
  };
  const iTime = col("time_tag");
  const iSpeed = col("speed");
  const iDensity = col("density");
  const iTemp = col("temperature");
  const iBx = col("bx");
  const iBy = col("by");
  const iBz = col("bz");
  const iBt = col("bt");

  const mag = [];
  const wind = [];
  let latestMag = null;
  let latestWind = null;

  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    if (!Array.isArray(r)) continue;
    const tag = bareTag(r[iTime]);
    if (tag === null) continue;

    const m = projectRow(
      {
        time_tag: tag,
        bz_gsm: num(r[iBz]),
        bt: num(r[iBt]),
        bx_gsm: num(r[iBx]),
        by_gsm: num(r[iBy]),
        source,
      },
      MAG_FIELDS
    );
    const w = projectRow(
      {
        time_tag: tag,
        proton_speed: num(r[iSpeed]),
        proton_density: num(r[iDensity]),
        proton_temperature: num(r[iTemp]),
        source,
      },
      WIND_FIELDS
    );

    mag.push(m);
    wind.push(w);
    // Last row carrying the value wins — the newest row can be partial.
    if (m.bz_gsm !== undefined) latestMag = m;
    if (w.proton_speed !== undefined) latestWind = w;
  }

  if (mag.length === 0) throw new Error("propagated feed carried no usable rows");
  return { mag, wind, latestMag, latestWind };
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = Number(v);
  return Number.isFinite(d) ? d : null;
}

// ── state io ───────────────────────────────────────────────────────────────

const EMPTY = { mag: [], wind: [], hemi: [], latest: {}, hemi_latest: null, source: null };

export async function readSeriesState(bucket) {
  try {
    const obj = await bucket.get(STATE_KEY);
    if (!obj) return { ...EMPTY, cold: true };
    const s = (await obj.json()) ?? {};
    return {
      mag: Array.isArray(s.mag) ? s.mag : [],
      wind: Array.isArray(s.wind) ? s.wind : [],
      hemi: Array.isArray(s.hemi) ? s.hemi : [],
      latest: s.latest ?? {},
      hemi_latest: s.hemi_latest ?? null,
      source: s.source ?? null,
      cold: false,
    };
  } catch (e) {
    console.log(`series state read failed: ${e.message}`);
    return { ...EMPTY, cold: true };
  }
}

export async function writeSeriesState(bucket, state) {
  const { cold, ...persist } = state;
  await bucket.put(STATE_KEY, JSON.stringify(persist), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}
