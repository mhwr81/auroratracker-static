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
 *    reads a 6.5 KB propagated feed (0.02 ms) and appends; a full RTSW read
 *    repairs one feed per hour on its own invocation. See series.js for why
 *    the small feed is trustworthy and how the repair tier keeps the series
 *    from drifting.
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
import { latestHp30, latestFlarePeak, readState, decideStorm, decideFlare, decideCme, commitState } from "./alerts.js";
import { publishSlow, buildSlow } from "./slow.js";
import {
  MAG_FIELDS,
  WIND_FIELDS,
  toIsoZ,
  fetchPropagated,
  mergeSeries,
  rebuildSeries,
  readSeriesState,
  writeSeriesState,
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

/**
 * How much hemispheric power history live.json carries.
 *
 * NOAA's file holds only the current UTC day, so at 00:05 it is one hour
 * long. Carrying a rolling window across that reset is the point: the
 * multi-day archive comes from a GitHub Action that runs a handful of times
 * a day and has been observed 8 hours behind, and the hole between where the
 * archive ends and where the reset file starts was showing up as a
 * multi-hour gap in the chart every midnight UTC.
 *
 * 30 hours covers the worst capture lag seen with room to spare, at ~360
 * rows -- a couple of KB once the edge compresses it.
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

/**
 * res.json() rather than JSON.parse(await res.text()). The two-step version
 * materialises the whole body as a JS string first and then walks it again;
 * on the 2.57 MB wind feed that intermediate string is not free, and the
 * only thing it bought was a byte count for the log line.
 */
async function getJson(url) {
  const res = await fetch(url, {
    headers: { ...UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
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
 * carries the series across that. What nobody can recover is the first ~66
 * minutes of valid times after a reset: those rows exist only in the
 * PREVIOUS day's file, which is what the capture job's near-midnight runs
 * are for.
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
 * Only used to seed a cold internal/series.json, so the 30-hour window
 * survives the migration off the old layout instead of restarting at one
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
      // 30 hours is ~360 rows. The app merges it over the capture job's
      // archive, newest source winning, and draws the result.
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

async function publishLive(env, state, label) {
  const live = assembleLive(state);
  const reject = publishable(live);
  if (reject) {
    console.log(`REFUSED to write: ${reject} — keeping previous ${OUT_KEY}`);
    return { written: false, reason: reject, live };
  }

  const body = JSON.stringify(live);
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
  const state = await readSeriesState(env.BUCKET);

  // A cold state is the migration off the old layout. Only the hemi window
  // is worth rescuing — mag and wind refill from the propagated feed within
  // the hour and are rebuilt wholesale at the next repair tick anyway.
  if (state.cold) {
    state.hemi = await hemiFromPublished(env);
    console.log(`cold start: seeded ${state.hemi.length} hemi rows from ${OUT_KEY}`);
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
    state.mag = mergeSeries(state.mag, sw.mag, now);
    state.wind = mergeSeries(state.wind, sw.wind, now);
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
    state.hemi = mergeHemi(state.hemi, hemi.series, now);
    state.hemi_latest = hemi.latest;
  }

  await writeSeriesState(env.BUCKET, state);
  const out = await publishLive(env, state, `fast ${Date.now() - started}ms`);
  return { ...out, state };
}

// ── the repair tier ────────────────────────────────────────────────────────

/**
 * Rebuild ONE feed's series from the full RTSW file, replacing it wholesale.
 *
 * One feed per invocation because the two parses together are ~5.6 ms and
 * the budget is 10 ms; alone, mag is 2.67 ms and wind 2.91 ms, which leaves
 * comfortable headroom for the merge and the two R2 writes.
 *
 * Wholesale replacement rather than a merge is the point. This is what stops
 * the series being append-only state that can drift from NOAA with no way
 * back: anything the fast tier got wrong, or missed during an outage longer
 * than the propagated feed's one-hour memory, is gone within the hour. RTSW
 * carries 24 hours, which is exactly the window the series keeps.
 *
 * This is also the only tier that sees `source` — the satellite id is not in
 * the propagated feed, so it is parked in state for the fast tier to stamp
 * onto its rows.
 */
async function tickRepair(env, which) {
  const started = Date.now();
  const url = which === "mag" ? MAG_URL : WIND_URL;
  const fields = which === "mag" ? MAG_FIELDS : WIND_FIELDS;

  const state = await readSeriesState(env.BUCKET);

  const sel = activeRecords(await getJson(url));
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

  await writeSeriesState(env.BUCKET, state);
  const out = await publishLive(env, state, `repair:${which} ${Date.now() - started}ms`);
  console.log(
    `repair ${which}: ${sel.length} active -> ${rebuilt.length} points, source=${source}`
  );
  return { ...out, repaired: true, which, points: rebuilt.length, state };
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
    latestHp30().catch((e) => { console.log(`hp30 failed: ${e.message}`); return null; }),
    latestFlarePeak().catch((e) => { console.log(`xrs failed: ${e.message}`); return null; }),
  ]);

  const state = await readState(env.BUCKET);
  const now = Date.now();
  const storm = decideStorm(sample, state, now);
  const flare = decideFlare(peak, state, now);

  // CME bulletins are read from the already-published slow tier rather than
  // queried here: DONKI is rate limited and unreliable, and re-fetching it
  // every few minutes to check for something it issues a few times a day
  // would undo the point of the fan-in. Latency is bounded by the slow
  // tier's half-hourly refresh, which matches the 30-minute WorkManager poll
  // this replaces.
  let cme = { send: false, reason: "slow tier unavailable" };
  try {
    const obj = await env.BUCKET.get("v1/slow.json");
    const slow = obj ? await obj.json() : null;
    cme = decideCme(slow?.donki?.notifications, state, now);
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

/** Alternate the two feeds so only one full RTSW parse lands per invocation. */
function repairTarget(now = new Date()) {
  return now.getUTCMinutes() < 30 ? "mag" : "wind";
}

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
      case CRON_REPAIR:
        return void (await tickRepair(env, repairTarget()).catch((e) =>
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
        const slow = await buildSlow(env);
        return Response.json(
          { dry_run: true, counts: slow.counts, errors: slow.errors, generated: slow.generated },
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
        const state = await readSeriesState(env.BUCKET);
        const live = assembleLive(state);
        return Response.json(
          {
            dry_run: true,
            cold: state.cold,
            next_repair: repairTarget(),
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
          stored: { mag: state.mag.length, wind: state.wind.length, hemi: state.hemi.length },
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

export { assembleLive, publishable, activeRecords, mergeHemi, repairTarget, tickFast, tickRepair };
