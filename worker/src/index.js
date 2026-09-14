/**
 * aurora-live — the live tier of the Aurora Tracker fan-in.
 *
 * Runs every 3 minutes, reads the fast-moving space weather feeds once for
 * the whole userbase, and writes a ~300-byte live.json to R2. The CDN serves
 * it from the edge, so upstream load stays constant no matter how many
 * installs there are.
 *
 * On reading the whole 4.5 MB of RTSW each run
 * ---------------------------------------------
 * Two smaller routes were tried and both rejected:
 *
 * 1. HTTP byte ranges. The feeds are newest-first and NOAA sends
 *    `Accept-Ranges: bytes`, and a plain HTTP client does get a 206 with
 *    88x fewer bytes. The Workers runtime STRIPS `Range` from subrequests —
 *    measured: plain, cf-bypass and no-store variants all returned 200 with
 *    the full 1,604,033 bytes and no `content-range`. Do not re-add it
 *    without re-measuring; it fails silently by returning correct values at
 *    full cost.
 *
 * 2. The /products/summary/ endpoints (61 bytes for bz and bt). They are
 *    rounded to whole nT — the same sample RTSW reports as bz -1.08, bt 4.05
 *    comes back as -1 and 4. Bz precision is the point of the card.
 *
 * So it reads both files in full. That is still ~347x less load on NOAA than
 * today, where every client pulls the same 4.5 MB for itself: 14,400 requests
 * and 64.6 GB a month, flat, for any number of installs.
 */

import { loadServiceAccount, sendToCondition } from "./fcm.js";
import { latestHp30, latestFlarePeak, readState, decideStorm, decideFlare, commitState } from "./alerts.js";

const MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json";
const WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
const HEMI_URL = "https://services.swpc.noaa.gov/text/aurora-nowcast-hemi-power.txt";

const UA = { "User-Agent": "AuroraTracker/1.0 (+https://auroratracker.app)" };
const TIMEOUT_MS = 15000;

const OUT_KEY = "v1/live.json";
const CACHE_CONTROL = "public, max-age=180, stale-while-revalidate=360";

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
  sel.sort((a, b) => String(a.time_tag).localeCompare(String(b.time_tag)));
  return sel;
}

/** NOAA emits `2026-09-14T01:59:00` with no zone. It is always UTC. */
function toIsoZ(timeTag) {
  if (!timeTag) return null;
  const s = String(timeTag);
  return s.endsWith("Z") ? s : s + "Z";
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

/** Newest record from the operational satellite. */
async function latestRtsw(url) {
  const raw = await get(url);
  const sel = activeRecords(JSON.parse(raw));
  if (sel.length === 0) {
    console.log(`no usable records in ${url}`);
    return null;
  }
  return { record: sel[sel.length - 1], bytes: raw.length, count: sel.length };
}

/**
 * Latest hemispheric power. Rows are keyed by column 2, NOAA's forecast
 * valid time at Earth, not the L1 observation time in column 1 — so the
 * tail of this file runs about an hour into the future by design.
 *
 * The file resets at 00:00 UTC and holds only the current day. Continuity
 * across that boundary is the capture job's responsibility, not this one's.
 */
async function latestHemi() {
  const body = await get(HEMI_URL);
  let north = null, south = null, valid = null, observed = null;

  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("-")) continue;
    const p = t.split(/\s+/);
    if (p.length < 4) continue;
    observed = p[0];
    valid = p[1];
    north = parseDouble(p[2]);
    south = parseDouble(p[3]);
  }
  return { north, south, valid_time: valid, observed_time: observed };
}

// ── build + publish ────────────────────────────────────────────────────────

async function build() {
  const [mag, wind, hemi] = await Promise.all([
    latestRtsw(MAG_URL),
    latestRtsw(WIND_URL),
    latestHemi().catch((e) => {
      console.log(`hemi fetch failed: ${e.message}`);
      return null;
    }),
  ]);

  const m = mag?.record ?? {};
  const w = wind?.record ?? {};
  const magTime = toIsoZ(m.time_tag);
  const windTime = toIsoZ(w.time_tag);

  const live = {
    schema: "v1",
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    solar_wind: {
      bz: parseDouble(m.bz_gsm),
      bt: parseDouble(m.bt),
      bx: parseDouble(m.bx_gsm),
      by: parseDouble(m.by_gsm),
      speed: parseDouble(w.proton_speed),
      density: parseDouble(w.proton_density),
      temperature: parseWide(w.proton_temperature),
      mag_time: magTime,
      wind_time: windTime,
      source: w.source ?? m.source ?? null,
      age_minutes: minutesOld(windTime ?? magTime),
    },
    hemispheric_power: hemi,
  };

  const diag = {
    mag_bytes: mag?.bytes ?? 0,
    wind_bytes: wind?.bytes ?? 0,
    mag_records: mag?.count ?? 0,
    wind_records: wind?.count ?? 0,
  };
  return { live, diag };
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

async function run(env) {
  const started = Date.now();
  const { live, diag } = await build();

  const reject = publishable(live);
  if (reject) {
    console.log(`REFUSED to write: ${reject} — keeping previous ${OUT_KEY}`);
    return { written: false, reason: reject, live, diag };
  }

  const body = JSON.stringify(live);
  await env.BUCKET.put(OUT_KEY, body, {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: CACHE_CONTROL,
    },
  });

  console.log(
    `wrote ${OUT_KEY} ${body.length}B in ${Date.now() - started}ms — ` +
      `bz=${live.solar_wind.bz} speed=${live.solar_wind.speed} ` +
      `age=${live.solar_wind.age_minutes}m read=${diag.mag_bytes + diag.wind_bytes}B`
  );
  return { written: true, bytes: body.length, live, diag };
}

/**
 * Evaluate storm and flare thresholds and push to the matching topics.
 *
 * Independent of the live.json write on purpose: a feed outage on one side
 * should not suppress the other, and alerting is the half that matters most.
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

  for (const [kind, d] of [["storm", storm], ["flare", flare]]) {
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
  if (armed) await commitState(env.BUCKET, state, storm, flare, now);
  return { armed, storm, flare, sample, peak };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.allSettled([
        run(env).catch((e) => console.log(`bundle run failed: ${e.stack || e.message}`)),
        runAlerts(env).catch((e) => console.log(`alert run failed: ${e.stack || e.message}`)),
      ])
    );
  },

  /**
   * Dry run for debugging: computes exactly what the cron would write and
   * returns it, without touching the bucket. Safe to leave public — it only
   * reads feeds that are already public, and it cannot publish.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/alerts") {
      try {
        const r = await runAlerts({ ...env, ALERTS_ARMED: "false" });
        return Response.json(r, { headers: { "cache-control": "no-store" } });
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
    try {
      const { live, diag } = await build();
      return Response.json(
        { dry_run: true, would_publish: publishable(live) === null, reject_reason: publishable(live), diag, live },
        { headers: { "cache-control": "no-store" } }
      );
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
};
