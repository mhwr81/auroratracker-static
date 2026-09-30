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

  // The window and dense-zone tests are string comparisons against cutoff
  // tags, so only the ~100 coarse rows pay for a Date.parse -- the fast tier
  // runs this over both series every 2 minutes. Tags are whole seconds, so
  // "t < cutoff" is exactly "tag < the cutoff rounded up to a second".
  const windowTag = cutoffTag(nowMs - SERIES_WINDOW_MS);
  const denseTag = cutoffTag(nowMs - DENSE_MS);

  for (const r of rows) {
    const tag = r?.time_tag;
    if (!isBareTag(tag)) {
      // Anything not in the bare RTSW spelling takes the general path.
      const t = tagMs(tag);
      if (Number.isNaN(t)) continue;
      if (nowMs - t > SERIES_WINDOW_MS) continue;
      if (nowMs - t > DENSE_MS) {
        if (t - lastCoarse < COARSE_MS) continue;
        lastCoarse = t;
      }
      out.push(r);
      continue;
    }
    if (tag < windowTag) continue;
    if (tag < denseTag) {
      const t = Date.parse(tag + "Z");
      if (Number.isNaN(t) || t - lastCoarse < COARSE_MS) continue;
      lastCoarse = t;
    }
    out.push(r);
  }
  return out;
}

/** `2026-09-14T01:59:00`: fixed width, whole seconds, no zone. */
function isBareTag(tag) {
  return typeof tag === "string" && tag.length === 19 && tag[10] === "T" && tag[4] === "-";
}

function cutoffTag(ms) {
  return new Date(Math.ceil(ms / 1000) * 1000).toISOString().slice(0, 19);
}

/**
 * mergeSeries for the fast tier's case: `prev` is stored state -- already
 * bare-tagged, sorted, deduplicated and thinned, because it is always the
 * output of this, mergeSeries or rebuildSeries -- and `fresh` is the last hour.
 *
 * Only the overlapping tail is merged. mergeSeries copies every stored row
 * into a Map and re-sorts the lot to fold in 60 rows, twice a tick; on the
 * free plan's 10 ms budget that was a measurable share of the fast tier.
 * The result is the same as mergeSeries(prev, fresh) (see the test).
 */
export function appendSeries(prev, fresh, nowMs) {
  if (!Array.isArray(prev) || prev.length === 0) return mergeSeries(prev, fresh, nowMs);
  const f = [];
  for (const r of Array.isArray(fresh) ? fresh : []) {
    const tag = bareTag(r?.time_tag);
    if (tag !== null) f.push(r.time_tag === tag ? r : { ...r, time_tag: tag });
  }
  if (f.length === 0) return applyDensity(prev, nowMs);
  f.sort((a, b) => (a.time_tag < b.time_tag ? -1 : a.time_tag > b.time_tag ? 1 : 0));

  const first = f[0].time_tag;
  let i = prev.length;
  while (i > 0 && prev[i - 1].time_tag >= first) i--;

  const byTime = new Map();
  for (let k = i; k < prev.length; k++) byTime.set(prev[k].time_tag, prev[k]);
  for (const r of f) byTime.set(r.time_tag, r);
  const tail = [...byTime.values()].sort((a, b) =>
    a.time_tag < b.time_tag ? -1 : a.time_tag > b.time_tag ? 1 : 0
  );
  return applyDensity(i === 0 ? tail : prev.slice(0, i).concat(tail), nowMs);
}

/**
 * True when fresh rows start more than a minute after the stored series ends:
 * the fast tier was down for longer than the propagated feed's one-hour
 * memory, and only a repair can fill what is missing.
 */
export function leavesGap(prev, fresh) {
  const last = Array.isArray(prev) && prev.length ? prev[prev.length - 1].time_tag : null;
  const first = Array.isArray(fresh) && fresh.length ? bareTag(fresh[0].time_tag) : null;
  if (last === null || first === null) return false;
  return tagMs(first) - tagMs(last) > 60_000;
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
  return propagatedRows(table[0], table.slice(1), source);
}

// ── the repair feed ────────────────────────────────────────────────────────

/**
 * Seven days of the same propagated table, both feeds in one 1.1 MB file.
 *
 * The repair tier rebuilds from this rather than from RTSW. Checked on
 * 2026-09-29 against RTSW's active spacecraft on every overlapping minute:
 * mag 1,400/1,400 and wind 1,387/1,387 identical in every field the app
 * reads. One read rebuilds both series where RTSW needed a 1.6 MB and a
 * 2.9 MB file on separate invocations, and only the last day of it is
 * parsed -- see sliceFrom.
 */
const PROPAGATED_FULL_URL =
  "https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind.json";

/**
 * The rows of a propagated table from `cutoffMs` on, parsing only that part.
 *
 * Rows are chronological and each starts `["<ISO time>`, so the first row of
 * the cutoff's hour can be found with indexOf and everything before it
 * skipped -- about six days of the seven. The slice starts a little before
 * the cutoff and the caller's density pass trims the rest. When no row of
 * the next few hours is found (a gap in the feed, or a changed shape) this
 * parses the whole table instead, so the result never depends on the slice.
 */
export function sliceFrom(text, cutoffMs) {
  const headerEnd = text.indexOf("]");
  const header = JSON.parse(text.slice(text.indexOf("[", 1), headerEnd + 1));
  let pos = -1;
  for (let h = 0; h < 3 && pos < 0; h++) {
    const hour = new Date(cutoffMs + h * 3600_000).toISOString().slice(0, 13);
    pos = text.indexOf(`["${hour}`, headerEnd);
  }
  if (pos < 0) {
    const table = JSON.parse(text);
    return { header: table[0], rows: table.slice(1) };
  }
  return { header, rows: JSON.parse("[" + text.slice(pos)) };
}

/** The last SERIES_WINDOW_MS of both feeds, for the repair tier. */
export async function fetchPropagatedDay(nowMs, source = null) {
  const res = await fetch(PROPAGATED_FULL_URL, {
    headers: { ...UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`propagated (7 day) -> HTTP ${res.status}`);
  const { header, rows } = sliceFrom(await res.text(), nowMs - SERIES_WINDOW_MS);
  return propagatedRows(header, rows, source);
}

/**
 * Mag-shaped and wind-shaped rows from a propagated table, oldest first.
 * `rows` excludes the header row.
 */
export function propagatedRows(headerRow, rows, source = null) {
  // By name, not by position — see the header note on the GSM frame.
  const header = headerRow.map((h) => String(h).trim());
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

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
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

/**
 * Besides the series, state carries the repair tier's bookkeeping:
 *
 *   repaired_at  last rebuild of both series from the 7-day propagated feed
 *   source_at    last RTSW read, the only feed that names the spacecraft
 *   gap_at       set by the fast tier when it could not bridge to the stored
 *                series; cleared by the next rebuild
 *
 * These are mirrored into the object's customMetadata so the repair tier can
 * decide whether it has anything to do from a HEAD, without downloading and
 * parsing the ~100 KB body on the 47 runs a day it has nothing to do.
 */
const EMPTY = { mag: [], wind: [], latest: {}, source: null, repaired_at: null, source_at: null, gap_at: null };

export async function readSeriesState(bucket) {
  try {
    const obj = await bucket.get(STATE_KEY);
    if (!obj) return { ...EMPTY, cold: true };
    const s = (await obj.json()) ?? {};
    return {
      mag: Array.isArray(s.mag) ? s.mag : [],
      wind: Array.isArray(s.wind) ? s.wind : [],
      latest: s.latest ?? {},
      source: s.source ?? null,
      repaired_at: s.repaired_at ?? null,
      source_at: s.source_at ?? null,
      gap_at: s.gap_at ?? null,
      cold: false,
    };
  } catch (e) {
    console.log(`series state read failed: ${e.message}`);
    return { ...EMPTY, cold: true };
  }
}

/** The bookkeeping alone, from a HEAD. Null when there is no state yet. */
export async function readSeriesMeta(bucket) {
  const obj = await bucket.head(STATE_KEY);
  if (!obj) return null;
  const m = obj.customMetadata ?? {};
  return { repaired_at: m.repaired_at || null, source_at: m.source_at || null, gap_at: m.gap_at || null };
}

/**
 * Only the solar wind half -- the hemi window lives in HEMI_KEY.
 *
 * `json` optionally carries the series already serialised, so the fast tier
 * can stringify each array once and reuse it for live.json (see liveBody).
 */
export async function writeSeriesState(bucket, state, json = {}) {
  const meta = { repaired_at: state.repaired_at ?? null, source_at: state.source_at ?? null, gap_at: state.gap_at ?? null };
  const body =
    `{"mag":${json.mag ?? JSON.stringify(state.mag)},"wind":${json.wind ?? JSON.stringify(state.wind)},` +
    `"latest":${JSON.stringify(state.latest ?? {})},"source":${JSON.stringify(state.source ?? null)},` +
    `${JSON.stringify(meta).slice(1)}`;
  await bucket.put(STATE_KEY, body, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    customMetadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v ?? ""])),
  });
}

/**
 * The hemispheric power window, in its own object rather than inside
 * internal/series.json.
 *
 * Split out because the hemi archive tier needs only this, and on a 10 ms
 * budget it cannot afford to parse ~100 KB of mag and wind series to get at
 * ~40 KB of hemi rows. `text` is the stored JSON, kept so the fast tier can
 * skip the write when NOAA has published nothing new -- the file moves every
 * 5 minutes and the tier runs every 2.
 */
export const HEMI_KEY = "internal/hemi.json";

export async function readHemiState(bucket) {
  try {
    const obj = await bucket.get(HEMI_KEY);
    if (!obj) return { hemi: [], hemi_latest: null, text: null, cold: true };
    const text = await obj.text();
    const s = JSON.parse(text) ?? {};
    return {
      hemi: Array.isArray(s.hemi) ? s.hemi : [],
      hemi_latest: s.hemi_latest ?? null,
      text,
      cold: false,
    };
  } catch (e) {
    console.log(`hemi state read failed: ${e.message}`);
    return { hemi: [], hemi_latest: null, text: null, cold: true };
  }
}

/** Writes only when the content changed; returns whether it did. */
export async function writeHemiState(bucket, hemiState, hemiJson = null) {
  const text =
    `{"hemi":${hemiJson ?? JSON.stringify(hemiState.hemi)},` +
    `"hemi_latest":${JSON.stringify(hemiState.hemi_latest ?? null)}}`;
  if (text === hemiState.text) return false;
  await bucket.put(HEMI_KEY, text, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
  hemiState.text = text;
  return true;
}
