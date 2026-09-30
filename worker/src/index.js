/**
 * aurora-live — the live tier of the Aurora Tracker fan-in.
 *
 * Reads the fast-moving space weather feeds once for the whole userbase and
 * writes a live.json to R2. The CDN serves it from the edge, so upstream
 * load stays constant no matter how many installs there are.
 *
 * Staying inside 10 ms of CPU
 * ---------------------------
 * The free plan allows 10 ms of CPU per invocation. The original design did
 * everything on one 3-minute cron and died with `exceededCpu`: reading both
 * RTSW files in full costs ~5.6 ms in JSON.parse alone (2.67 ms for 1.46 MB
 * of mag, 2.91 ms for 2.57 MB of wind), and the bundle, the alerts and the
 * slow tier were all sharing that single budget through ctx.waitUntil —
 * which bills to the invocation that scheduled it.
 *
 * Two things fixed it, and both matter:
 *
 * 1. FOUR CRONS INSTEAD OF ONE. Each trigger is its own invocation with its
 *    own 10 ms, so the jobs stop competing. They are offset rather than
 *    simultaneous so that two never land on the same minute.
 *
 * 2. THE SOLAR WIND SERIES IS STATE, NOT A RECOMPUTATION. The 3-minute tick
 *    reads a 6.5 KB propagated feed (0.02 ms) and appends; the repair tier
 *    rebuilds both series after a gap and twice a day regardless. See
 *    series.js for why the small feed is trustworthy and tickRepair for how
 *    the series is kept from drifting.
 *
 * On the routes that were tried and rejected
 * ------------------------------------------
 * Byte ranges: the Workers runtime STRIPS `Range` from subrequests —
 * measured, plain/cf-bypass/no-store variants all returned 200 with the full
 * body and no `content-range`. It fails silently by returning correct values
 * at full cost, so do not re-add it without re-measuring.
 *
 * The /products/summary/ endpoints: rounded to whole nT — the sample RTSW
 * reports as bz -1.08 comes back as -1. Bz precision is the point of the
 * card. (The propagated feed now used instead is NOT rounded; it carries the
 * same values RTSW does, bit for bit.)
 */

import { loadServiceAccount, sendToCondition } from "./fcm.js";
import { latestNoaaGScale, latestFlarePeak, readState, decideStorm, decideFlare, decideCme, commitState } from "./alerts.js";
import { publishSlow, buildSlow, readDonki } from "./slow.js";
import { publishHemiArchive } from "./hemi_archive.js";
import {
  MAG_FIELDS,
  WIND_FIELDS,
  toIsoZ,
  fetchPropagated,
  fetchPropagatedDay,
  appendSeries,
  leavesGap,
  readSeriesMeta,
  rebuildSeries,
  readSeriesState,
  writeSeriesState,
  readHemiState,
  writeHemiState,
} from "./series.js";

const MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json";
const WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
const HEMI_URL = "https://services.swpc.noaa.gov/text/aurora-nowcast-hemi-power.txt";

const UA = { "User-Agent": "AuroraTracker/1.0 (+https://auroratracker.app)" };
const TIMEOUT_MS = 15000;

const OUT_KEY = "v1/live.json";

/**
 * max-age matches the 2-minute publish cadence: inside that window the edge is
 * serving the newest object there is, so a shorter TTL would only re-fetch
 * identical bytes.
 *
 * The stale window is 60s, not the 360s it started at. That combination
 * permitted the edge to answer with something up to NINE minutes old, and it
 * sat underneath three more layers of the same idea -- a 150s bundle cache and
 * a 2-minute response cache in the app -- so a reading could be a quarter of an
 * hour old by the time it was drawn, on a feed that publishes every minute.
 *
 * 60s still absorbs the thundering herd at the moment an object expires, which
 * is all stale-while-revalidate is really for here. The cost is that a request
 * arriving during a revalidation waits for the origin rather than taking an
 * instant stale answer, so p99 gets slightly worse in exchange for the p50
 * being several minutes fresher.
 */
const CACHE_CONTROL = "public, max-age=120, stale-while-revalidate=60";

const HEMI_TIME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$/;

// The cron expressions from wrangler.toml, which arrive verbatim as
// event.cron. Kept as constants so the schedule and the branch cannot drift
// apart silently — a typo here means a job never runs and nothing errors.
//
// The minutes are chosen so no two jobs ever land together, which is what
// keeps each inside its own 10 ms. With the fast tier on every EVEN minute,
// everything else has to be odd, and the arithmetic that guarantees it is:
//
//   fast    */2      0,2,4…58        even
//   alerts  1-59/4   1,5,9…57        odd — step 4 preserves parity
//   slow    3,35                     odd, ≡3 (mod 4), so never an alert minute
//   repair  15,47                    odd, ≡3 (mod 4), and not a slow minute
//   hemi    27,59                    odd, ≡3 (mod 4), neither of the above
//
// A step of 3 cannot be used for alerts any more: it alternates parity
// (1,4,7,10…) and every second entry would collide with the fast tier.
//
// Line comments, not a block: `*/2` contains the sequence that ends a block
// comment, so writing this schedule inside /** */ silently truncates the file
// at the word "fast".
export const CRON_FAST = "*/2 * * * *";
export const CRON_ALERTS = "1-59/4 * * * *";
export const CRON_SLOW = "3,35 * * * *";
export const CRON_REPAIR = "15,47 * * * *";
export const CRON_HEMI = "27,59 * * * *";

/**
 * How much hemispheric power history live.json carries.
 *
 * NOAA's file holds only the current UTC day, so at 00:05 it is one hour
 * long. Carrying a rolling window across that reset is the point, and it is
 * also the source of the multi-day archive: the slow tier folds this window
 * into slow.json's hemi_history every 30 minutes (hemi_archive.js), so the
 * window only has to outlast the gap between two slow runs.
 *
 * 30 hours is far more than that needs, at ~360 rows -- a couple of KB once
 * the edge compresses it. It was sized for the GitHub Action that used to
 * build the archive and was seen running 8 hours behind.
 */
const HEMI_WINDOW_MS = 30 * 3600_000;

// ── parsing helpers ────────────────────────────────────────────────────────

/** Mirrors ApiService._parseDouble — rejects values outside the sane band. */
function parseDouble(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = Number(v);
  if (!Number.isFinite(d)) return null;
  return Math.abs(d) > 99999 ? null : d;
}

/**
 * Mirrors ApiService._parseWideDouble. Plasma temperatures run 1e5-1e6 K
 * and ephemeris values reach 1e6 km, so these legitimately exceed the
 * bounds parseDouble enforces.
 */
function parseWide(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = Number(v);
  return Number.isFinite(d) ? d : null;
}

/**
 * Mirrors ApiService._fetchRtswActiveRecords: keep records carrying a
 * time_tag, prefer the satellite flagged operational, otherwise fall back
 * to whichever source reported first, then sort oldest to newest.
 */
function activeRecords(records) {
  const all = records.filter(
    (e) => e && typeof e === "object" && e.time_tag !== null && e.time_tag !== undefined
  );
  if (all.length === 0) return [];

  let sel = all.filter((e) => e.active === true);
  if (sel.length === 0) {
    const fallback = all[0].source;
    sel = all.filter((e) => e.source === fallback);
  }
  // Fixed-width ISO strings, so byte order is chronological order.
  sel.sort((a, b) => {
    const x = String(a.time_tag), y = String(b.time_tag);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return sel;
}

const ACTIVE_RE = /"active"\s*:\s*true\b/g;

/**
 * activeRecords() over the raw RTSW text, parsing only the active
 * spacecraft's rows.
 *
 * The feeds carry every spacecraft (SOLAR1, ACE and IMAP as of Sep 2026), so
 * two thirds of each file is rows activeRecords() throws away. JSON.parse
 * builds all of them first, and on the free plan's 10 ms budget that is the
 * single biggest cost in the repair tier. Records are flat objects, so each
 * active one is the {...} enclosing its "active": true -- found with a string
 * scan that is far cheaper than materialising the rows.
 *
 * Anything unexpected (no active flag at all, or a shape the scan cannot
 * slice cleanly) falls back to the full parse, so the result never differs.
 */
export function activeRecordsFromText(text) {
  const parts = [];
  for (const m of text.matchAll(ACTIVE_RE)) {
    const start = text.lastIndexOf("{", m.index);
    const end = text.indexOf("}", m.index);
    if (start >= 0 && end > start) parts.push(text.slice(start, end + 1));
  }
  if (parts.length > 0) {
    try {
      return activeRecords(JSON.parse(`[${parts.join(",")}]`));
    } catch {
      console.log("active-row scan produced invalid JSON; using full parse");
    }
  }
  return activeRecords(JSON.parse(text));
}

function minutesOld(isoZ) {
  if (!isoZ) return null;
  const t = Date.parse(isoZ);
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

async function get(url) {
  const res = await fetch(url, {
    headers: { ...UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// ── hemispheric power ──────────────────────────────────────────────────────

/**
 * Hemispheric power: the latest reading, and the whole current-day series.
 *
 * Rows are keyed by column 2, NOAA's forecast valid time at Earth, not the
 * L1 observation time in column 1, so the tail of this file runs about an
 * hour into the future by design.
 *
 * The file resets at 00:00 UTC and holds only the current day -- mergeHemi
 * carries the series across that. The first ~66 minutes of valid times after
 * a reset exist only in the PREVIOUS day's file; capturing every 2 minutes
 * means the last pre-reset tick already has them.
 *
 * Rows missing north or south are dropped rather than published as nulls.
 * NOAA writes those as "(n/a)" and an earlier version took the last line
 * unconditionally, publishing a null pair whenever the file ended on one.
 *
 * At 11.6 KB and 0.06 ms this is cheap enough to keep on the 3-minute tick.
 */
async function latestHemi() {
  const body = await get(HEMI_URL);
  const series = [];
  let validRaw = null, observedRaw = null;

  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("-")) continue;
    const p = t.split(/\s+/);
    if (p.length < 4) continue;
    if (!HEMI_TIME_RE.test(p[0]) || !HEMI_TIME_RE.test(p[1])) continue;
    const north = parseDouble(p[2]);
    const south = parseDouble(p[3]);
    if (north === null || south === null) continue;

    observedRaw = p[0];
    validRaw = p[1];
    series.push({
      time: `${p[1].replace("_", "T")}:00Z`,
      obs_time: `${p[0].replace("_", "T")}:00Z`,
      north,
      south,
    });
  }

  if (series.length === 0) throw new Error("hemi feed carried no usable rows");
  const last = series[series.length - 1];
  return {
    latest: { north: last.north, south: last.south, valid_time: validRaw, observed_time: observedRaw },
    series,
  };
}

/**
 * Carry the published series across NOAA's 00:00 UTC reset.
 *
 * Keyed by valid time with fresh rows winning: OVATION recomputes the
 * L1->Earth lag per row from the observed wind speed, so a row can be
 * republished at a slightly different valid time, and the newer file is the
 * better answer.
 *
 * The cutoff is a lower bound only. The last ~hour of the series is
 * OVATION's forecast and is legitimately in the future, so trimming at both
 * ends would discard that tail on every run.
 */
function mergeHemi(prev, fresh, nowMs) {
  const cutoff = nowMs - HEMI_WINDOW_MS;
  const byTime = new Map();
  for (const r of prev) {
    const t = Date.parse(r?.time);
    if (!Number.isNaN(t) && t >= cutoff) byTime.set(r.time, r);
  }
  for (const r of fresh) byTime.set(r.time, r);
  return [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/**
 * The hemi series as last published, read from live.json.
 *
 * Only used to seed a cold internal/hemi.json, so the 30-hour window
 * survives a migration of the state layout instead of restarting at one
 * day's worth of rows. After that first tick, state is the source of truth.
 */
async function hemiFromPublished(env) {
  try {
    const obj = await env.BUCKET.get(OUT_KEY);
    if (!obj) return [];
    const s = (await obj.json())?.series?.hemi;
    return Array.isArray(s) ? s : [];
  } catch (e) {
    console.log(`published hemi read failed: ${e.message}`);
    return [];
  }
}

// ── assembling + publishing live.json ──────────────────────────────────────

/**
 * Build the public bundle from state. Every tier writes state and then calls
 * this, so the published shape is defined in exactly one place and a repair
 * tick republishes the same document the fast tick would have.
 */
function assembleLive(state) {
  const l = state.latest ?? {};
  const magTime = l.mag_time ?? null;
  const windTime = l.wind_time ?? null;

  return {
    schema: "v1",
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    solar_wind: {
      bz: parseDouble(l.bz),
      bt: parseDouble(l.bt),
      bx: parseDouble(l.bx),
      by: parseDouble(l.by),
      speed: parseDouble(l.speed),
      density: parseDouble(l.density),
      temperature: parseWide(l.temperature),
      mag_time: magTime,
      wind_time: windTime,
      source: state.source ?? null,
      age_minutes: minutesOld(windTime ?? magTime),
    },
    hemispheric_power: state.hemi_latest ?? null,
    // Same shape ApiService._fetchRtswActiveRecords would have produced from
    // the raw feed, so every chart builder downstream works unchanged.
    series: {
      mag: state.mag.length > 0 ? state.mag : null,
      wind: state.wind.length > 0 ? state.wind : null,
      // Not downsampled: NOAA publishes this at 5-minute cadence already, so
      // 30 hours is ~360 rows. The app merges it over slow.json's
      // hemi_history archive, newest source winning, and draws the result.
      hemi: state.hemi.length > 0 ? state.hemi : null,
    },
  };
}

/**
 * A bundle missing bz or speed is worse than a stale one: live.json feeds
 * the conditions card and the alert thresholds, so a blank write would
 * blank the app rather than leave the last good value in place. Refuse it
 * and let the previous object stand.
 */
function publishable(live) {
  const sw = live.solar_wind;
  if (sw.bz === null || sw.speed === null) return "bz or speed missing";
  if (sw.age_minutes !== null && sw.age_minutes > 180) return `data ${sw.age_minutes}m old`;
  return null;
}

/**
 * JSON.stringify(live), reusing series arrays the caller already serialised
 * for state. The fast tier writes the same ~130 KB of series to state and to
 * live.json on every tick, so stringifying it once instead of twice is a
 * real share of a 10 ms budget. `series` is the last key of assembleLive's
 * document, which is what makes appending it here produce identical bytes.
 */
export function liveBody(live, json = {}) {
  const { series, ...head } = live;
  const part = (k) => (series[k] === null ? "null" : json[k] ?? JSON.stringify(series[k]));
  return `${JSON.stringify(head).slice(0, -1)},"series":{"mag":${part("mag")},"wind":${part("wind")},"hemi":${part("hemi")}}}`;
}

/** Each array serialised once, for writeSeriesState, writeHemiState and liveBody. */
function serialise(state, hemi) {
  return { mag: JSON.stringify(state.mag), wind: JSON.stringify(state.wind), hemi: JSON.stringify(hemi) };
}

async function publishLive(env, state, label, json = {}) {
  const live = assembleLive(state);
  const reject = publishable(live);
  if (reject) {
    console.log(`REFUSED to write: ${reject} — keeping previous ${OUT_KEY}`);
    return { written: false, reason: reject, live };
  }

  const body = liveBody(live, json);
  await env.BUCKET.put(OUT_KEY, body, {
    httpMetadata: { contentType: "application/json", cacheControl: CACHE_CONTROL },
  });

  console.log(
    `[${label}] wrote ${OUT_KEY} ${body.length}B — bz=${live.solar_wind.bz} ` +
      `speed=${live.solar_wind.speed} age=${live.solar_wind.age_minutes}m ` +
      `mag=${state.mag.length} wind=${state.wind.length} hemi=${state.hemi.length}`
  );
  return { written: true, bytes: body.length, live };
}

// ── the fast tier ──────────────────────────────────────────────────────────

/**
 * Every 3 minutes: 6.5 KB of solar wind and 11.6 KB of hemispheric power.
 *
 * Both fetches are allowed to fail independently and neither failure blanks
 * anything — state simply keeps what it had. That is the whole reason the
 * series moved into state: one bad NOAA response used to mean a hole in
 * every chart, and now it means the window does not advance for a tick.
 */
async function tickFast(env) {
  const started = Date.now();
  const [state, hs] = await Promise.all([readSeriesState(env.BUCKET), readHemiState(env.BUCKET)]);

  // A cold hemi state is a migration of the layout. Only the hemi window is
  // worth rescuing — mag and wind refill from the propagated feed within the
  // hour and are rebuilt wholesale at the next repair tick anyway.
  if (hs.cold) {
    hs.hemi = await hemiFromPublished(env);
    console.log(`cold start: seeded ${hs.hemi.length} hemi rows from ${OUT_KEY}`);
  }

  const [sw, hemi] = await Promise.all([
    fetchPropagated(state.source).catch((e) => {
      console.log(`propagated fetch failed: ${e.message}`);
      return null;
    }),
    latestHemi().catch((e) => {
      console.log(`hemi fetch failed: ${e.message}`);
      return null;
    }),
  ]);

  const now = Date.now();

  if (sw) {
    // An empty series or a hole at the join is something only the repair
    // tier can fill; flag it so the next repair slot rebuilds.
    if (state.mag.length === 0 || leavesGap(state.mag, sw.mag) || leavesGap(state.wind, sw.wind)) {
      state.gap_at = new Date(now).toISOString();
    }
    state.mag = appendSeries(state.mag, sw.mag, now);
    state.wind = appendSeries(state.wind, sw.wind, now);
    const m = sw.latestMag ?? {};
    const w = sw.latestWind ?? {};
    state.latest = {
      ...state.latest,
      ...(sw.latestMag && {
        bz: m.bz_gsm ?? null,
        bt: m.bt ?? null,
        bx: m.bx_gsm ?? null,
        by: m.by_gsm ?? null,
        mag_time: toIsoZ(m.time_tag),
      }),
      ...(sw.latestWind && {
        speed: w.proton_speed ?? null,
        density: w.proton_density ?? null,
        temperature: w.proton_temperature ?? null,
        wind_time: toIsoZ(w.time_tag),
      }),
    };
  }

  if (hemi) {
    hs.hemi = mergeHemi(hs.hemi, hemi.series, now);
    hs.hemi_latest = hemi.latest;
  }

  const json = serialise(state, hs.hemi);
  await Promise.all([writeSeriesState(env.BUCKET, state, json), writeHemiState(env.BUCKET, hs, json.hemi)]);
  const view = { ...state, hemi: hs.hemi, hemi_latest: hs.hemi_latest };
  const out = await publishLive(env, view, `fast ${Date.now() - started}ms`, json);
  return { ...out, state: view };
}

// ── the repair tier ────────────────────────────────────────────────────────

/**
 * The repair tier: rebuild the series wholesale when there is a reason to.
 *
 * Wholesale replacement rather than a merge is the point. This is what stops
 * the series being append-only state that can drift from NOAA with no way
 * back: anything the fast tier got wrong, or missed during an outage longer
 * than the propagated feed's one-hour memory, is replaced by the next
 * rebuild.
 *
 * It used to rebuild one feed from RTSW on every run, 48 times a day, and
 * every one of those ran 12-27 ms against a 10 ms budget: the RTSW files are
 * 1.6 and 2.9 MB, and decompressing and decoding them costs several ms
 * before any JavaScript runs, so no amount of parser work could fit it. But
 * the fast tier already re-merges the last 60 minutes every 2 minutes from a
 * feed identical to RTSW, so a rebuild only changes anything after a gap or
 * a late revision. The slots still run twice an hour, and most of them now
 * cost a HEAD request:
 *
 *   gap flagged by the fast tier     rebuild both from the 7-day propagated feed
 *   no rebuild for REBUILD_EVERY_MS  the same, to catch late revisions
 *   no RTSW read for SOURCE_EVERY_MS one RTSW mag rebuild, the only feed that
 *                                    names the spacecraft (`source`)
 *
 * That is ~3 expensive runs a day instead of 48, plus one per real outage.
 */
const REBUILD_EVERY_MS = 12 * 3600_000;
const SOURCE_EVERY_MS = 24 * 3600_000;

/** What this repair slot should do: "rebuild", "rtsw", or null for nothing. */
export function repairDue(meta, nowMs = Date.now()) {
  const older = (iso, ms) => !iso || !(nowMs - Date.parse(iso) < ms);
  if (!meta || meta.gap_at) return "rebuild";
  if (older(meta.repaired_at, REBUILD_EVERY_MS)) return "rebuild";
  if (older(meta.source_at, SOURCE_EVERY_MS)) return "rtsw";
  return null;
}

async function tickRepair(env) {
  const action = repairDue(await readSeriesMeta(env.BUCKET));
  if (action === "rebuild") return rebuildFromPropagated(env);
  if (action === "rtsw") return repairFromRtsw(env, "mag");
  console.log("repair: nothing due");
  return { repaired: false, reason: "not due" };
}

/**
 * Rebuild both series from the last day of the 7-day propagated feed. Rows
 * the fast tier stored after the feed's newest are kept -- the 1-hour feed
 * can be a few minutes ahead -- and `latest` is left to the fast tier,
 * which reads the fresher of the two.
 */
async function rebuildFromPropagated(env) {
  const started = Date.now();
  const [state, hs] = await Promise.all([readSeriesState(env.BUCKET), readHemiState(env.BUCKET)]);
  const now = Date.now();
  const sw = await fetchPropagatedDay(now, state.source);

  const replace = (stored, rows, fields) => {
    const rebuilt = rebuildSeries(rows, fields, now, state.source);
    if (rebuilt.length === 0) return stored;
    const last = rebuilt[rebuilt.length - 1].time_tag;
    let i = stored.length;
    while (i > 0 && stored[i - 1].time_tag > last) i--;
    return i === stored.length ? rebuilt : rebuilt.concat(stored.slice(i));
  };
  state.mag = replace(state.mag, sw.mag, MAG_FIELDS);
  state.wind = replace(state.wind, sw.wind, WIND_FIELDS);
  if (!state.latest?.mag_time || !state.latest?.wind_time) {
    const m = sw.latestMag ?? {}, w = sw.latestWind ?? {};
    state.latest = {
      ...state.latest,
      ...(!state.latest?.mag_time && sw.latestMag && {
        bz: m.bz_gsm ?? null, bt: m.bt ?? null, bx: m.bx_gsm ?? null, by: m.by_gsm ?? null,
        mag_time: toIsoZ(m.time_tag),
      }),
      ...(!state.latest?.wind_time && sw.latestWind && {
        speed: w.proton_speed ?? null, density: w.proton_density ?? null,
        temperature: w.proton_temperature ?? null, wind_time: toIsoZ(w.time_tag),
      }),
    };
  }
  state.repaired_at = new Date(now).toISOString();
  state.gap_at = null;

  const json = serialise(state, hs.hemi);
  await writeSeriesState(env.BUCKET, state, json);
  const view = { ...state, hemi: hs.hemi, hemi_latest: hs.hemi_latest };
  const out = await publishLive(env, view, `repair:rebuild ${Date.now() - started}ms`, json);
  console.log(`repair rebuild: mag=${state.mag.length} wind=${state.wind.length} points`);
  return { ...out, repaired: true, which: "both", state: view };
}

/**
 * Rebuild ONE feed's series from the full RTSW file, replacing it wholesale.
 *
 * Now run once a day, for `source` -- the satellite id is not in the
 * propagated feed, so it is parked in state for the other tiers to stamp
 * onto their rows. Parsing only the active spacecraft's rows
 * (activeRecordsFromText) keeps the JavaScript side small, but the download
 * alone is over budget; once a day, that is tolerated.
 */
async function repairFromRtsw(env, which) {
  const started = Date.now();
  const url = which === "mag" ? MAG_URL : WIND_URL;
  const fields = which === "mag" ? MAG_FIELDS : WIND_FIELDS;

  const [state, hs] = await Promise.all([readSeriesState(env.BUCKET), readHemiState(env.BUCKET)]);

  const sel = activeRecordsFromText(await get(url));
  if (sel.length === 0) {
    console.log(`repair ${which}: no usable records, keeping previous series`);
    return { repaired: false, which };
  }

  const newest = sel[sel.length - 1];
  const source = newest.source ?? state.source ?? null;

  // Replace rather than merge — that is what makes this a repair and not
  // another append. See rebuildSeries for why it is not mergeSeries([], ...).
  const rebuilt = rebuildSeries(sel, fields, Date.now(), source);

  state.source = source;
  state[which] = rebuilt;
  state.latest = {
    ...state.latest,
    ...(which === "mag"
      ? {
          bz: newest.bz_gsm ?? null,
          bt: newest.bt ?? null,
          bx: newest.bx_gsm ?? null,
          by: newest.by_gsm ?? null,
          mag_time: toIsoZ(newest.time_tag),
        }
      : {
          speed: newest.proton_speed ?? null,
          density: newest.proton_density ?? null,
          temperature: newest.proton_temperature ?? null,
          wind_time: toIsoZ(newest.time_tag),
        }),
  };

  state.source_at = new Date().toISOString();

  const json = serialise(state, hs.hemi);
  await writeSeriesState(env.BUCKET, state, json);
  const view = { ...state, hemi: hs.hemi, hemi_latest: hs.hemi_latest };
  const out = await publishLive(env, view, `repair:${which} ${Date.now() - started}ms`, json);
  console.log(
    `repair ${which}: ${sel.length} active -> ${rebuilt.length} points, source=${source}`
  );
  return { ...out, repaired: true, which, points: rebuilt.length, state: view };
}

// ── alerts ─────────────────────────────────────────────────────────────────

/**
 * Evaluate storm and flare thresholds and push to the matching topics.
 *
 * On its own cron, offset one minute from the bundle. Independent of the
 * live.json write on purpose: a feed outage on one side should not suppress
 * the other, and alerting is the half that matters most.
 *
 * ALERTS_ARMED gates the actual send. Until it is set to "true" this logs
 * exactly what it would have pushed and to which topic condition, so the
 * rules can be watched against real conditions before any device is woken.
 */
async function runAlerts(env) {
  const armed = env.ALERTS_ARMED === "true";
  const [sample, peak] = await Promise.all([
    latestNoaaGScale().catch((e) => { console.log(`noaa scales failed: ${e.message}`); return null; }),
    latestFlarePeak().catch((e) => { console.log(`xrs failed: ${e.message}`); return null; }),
  ]);

  const state = await readState(env.BUCKET);
  const now = Date.now();
  const storm = decideStorm(sample, state, now);
  const flare = decideFlare(peak, state, now);

  // CME bulletins are read from what the slow tier last fetched rather than
  // queried here: DONKI is rate limited and unreliable, and re-fetching it
  // every few minutes to check for something it issues a few times a day
  // would undo the point of the fan-in. Latency is bounded by the slow
  // tier's half-hourly refresh, which matches the 30-minute WorkManager poll
  // this replaces. Read from internal/donki.json, not slow.json: slow.json
  // carries the ~100 KB hemi archive too, and parsing that every 4 minutes
  // to reach 11 KB of bulletins cost this tier half its CPU again.
  let cme = { send: false, reason: "slow tier unavailable" };
  try {
    const donki = await readDonki(env.BUCKET);
    cme = decideCme(donki?.notifications, state, now);
  } catch (e) {
    console.log(`cme read failed: ${e.message}`);
  }

  for (const [kind, d] of [["storm", storm], ["flare", flare], ["cme", cme]]) {
    if (!d.send) { console.log(`${kind}: no send — ${d.reason}`); continue; }
    const tag = `${kind} ${d.level}${d.escalated ? " (escalated)" : ""} -> ${d.condition}`;
    if (!armed) { console.log(`DRY RUN would send ${tag}`); continue; }
    try {
      const sa = loadServiceAccount(env.FCM_SERVICE_ACCOUNT);
      const id = await sendToCondition(sa, d.condition, d.data);
      console.log(`SENT ${tag} — ${id}`);
    } catch (e) {
      console.log(`send failed for ${kind}: ${e.message}`);
      d.send = false; // do not record state for an alert nobody received
    }
  }

  // Only commit once a send actually succeeded, so a failed push retries on
  // the next tick instead of being deduped away by its own state write.
  // Seeding and suppression must be recorded even when nothing was sent, or
  // the first tick would re-examine the same bulletins forever.
  if (armed) await commitState(env.BUCKET, state, storm, flare, now, cme);
  return { armed, storm, flare, cme, sample, peak };
}

// ── entry points ───────────────────────────────────────────────────────────

export default {
  /**
   * One job per invocation, so each gets its own 10 ms of CPU. Nothing is
   * wrapped in ctx.waitUntil any more — that billed the deferred work back
   * to the invocation that scheduled it, which is how three jobs ended up
   * sharing one budget in the first place.
   */
  async scheduled(event, env, ctx) {
    switch (event.cron) {
      case CRON_ALERTS:
        return void (await runAlerts(env).catch((e) =>
          console.log(`alert run failed: ${e.stack || e.message}`)
        ));
      case CRON_SLOW:
        return void (await publishSlow(env).catch((e) =>
          console.log(`slow run failed: ${e.stack || e.message}`)
        ));
      case CRON_HEMI:
        return void (await publishHemiArchive(env.BUCKET).catch((e) =>
          console.log(`hemi archive run failed: ${e.stack || e.message}`)
        ));
      case CRON_REPAIR:
        return void (await tickRepair(env).catch((e) =>
          console.log(`repair run failed: ${e.stack || e.message}`)
        ));
      case CRON_FAST:
        return void (await tickFast(env).catch((e) =>
          console.log(`bundle run failed: ${e.stack || e.message}`)
        ));
      default:
        // An unrecognised schedule means wrangler.toml and this file have
        // drifted. Do the cheap tick rather than nothing, and say so loudly.
        console.log(`unmapped cron "${event.cron}" — running fast tier`);
        return void (await tickFast(env).catch((e) =>
          console.log(`bundle run failed: ${e.stack || e.message}`)
        ));
    }
  },

  /**
   * Debug routes. Safe to leave public — they only read feeds that are
   * already public, and the dry-run paths cannot publish.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/alerts") {
      try {
        const r = await runAlerts({ ...env, ALERTS_ARMED: "false" });
        // Report what the CRON would do, which is the question that matters --
        // this route always dry-runs, so r.armed is false by construction.
        const raw = env.ALERTS_ARMED;
        return Response.json(
          {
            ...r,
            cron_would_send: raw === "true",
            armed_secret: raw === undefined
              ? "not set"
              : raw === "true"
                ? "ok"
                : `set but does not equal "true" (len ${raw.length}, trimmed "${raw.trim()}")`,
          },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/slow") {
      try {
        const { slow } = await buildSlow(env);
        return Response.json(
          { dry_run: true, counts: slow.counts, stale: slow.stale, errors: slow.errors, generated: slow.generated },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/fcm-check") {
      try {
        const sa = loadServiceAccount(env.FCM_SERVICE_ACCOUNT);
        return Response.json({ ok: true, project_id: sa.project_id, client_email: sa.client_email });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // Current state, without touching the bucket. `?series=1` includes the
    // arrays; by default it reports their shape, which is what is usually
    // being asked and keeps the response readable.
    if (url.pathname === "/state") {
      try {
        const [series, hs] = await Promise.all([readSeriesState(env.BUCKET), readHemiState(env.BUCKET)]);
        const state = { ...series, hemi: hs.hemi, hemi_latest: hs.hemi_latest };
        const live = assembleLive(state);
        return Response.json(
          {
            dry_run: true,
            cold: series.cold,
            hemi_cold: hs.cold,
            next_repair: repairDue(await readSeriesMeta(env.BUCKET)) ?? "nothing due",
            repair: { repaired_at: series.repaired_at, source_at: series.source_at, gap_at: series.gap_at },
            would_publish: publishable(live) === null,
            reject_reason: publishable(live),
            counts: { mag: state.mag.length, wind: state.wind.length, hemi: state.hemi.length },
            span: {
              mag: span(state.mag, "time_tag"),
              wind: span(state.wind, "time_tag"),
              hemi: span(state.hemi, "time"),
            },
            live: url.searchParams.get("series") ? live : { ...live, series: undefined },
          },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // Dry run of the cheap feed: what the 3-minute tick would have appended.
    try {
      const state = await readSeriesState(env.BUCKET);
      const sw = await fetchPropagated(state.source);
      return Response.json(
        {
          dry_run: true,
          fresh_rows: sw.mag.length,
          latest_mag: sw.latestMag,
          latest_wind: sw.latestWind,
          stored: { mag: state.mag.length, wind: state.wind.length },
        },
        { headers: { "cache-control": "no-store" } }
      );
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
};

function span(rows, key) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { from: rows[0]?.[key] ?? null, to: rows[rows.length - 1]?.[key] ?? null };
}

export { assembleLive, publishable, activeRecords, mergeHemi, tickFast, tickRepair, rebuildFromPropagated, repairFromRtsw };
