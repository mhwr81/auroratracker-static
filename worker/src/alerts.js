/**
 * Storm and flare threshold evaluation, moved off the device.
 *
 * Storms alert on NOAA SWPC's official G-scale -- the same noaa-scales.json
 * value the app's conditions card displays -- so a push never names a storm
 * level the app is not showing. Flares are a port of showSolarFlareAlert.
 * Either way the rule is the same: a threshold that means one thing on screen
 * and another in a push is worse than no push.
 *
 * Storms used to alert on a single 30-minute GFZ Hp30 sample. Hp30 reaching 5
 * for half an hour is not a G1 by NOAA's definition (3-hour Kp), so users got
 * "G1" pushes on days the app -- and NOAA -- said G0.
 *
 * What changed in moving here is WHO filters. On-device, every install
 * evaluated its own threshold after fetching. Here the server evaluates once
 * and the TOPIC does the filtering: a device subscribed to `storm_g2` gets a
 * message only when the observed level is G2 or higher, because the sender
 * addresses g1..gObserved and nothing above it.
 */

import { topicCondition } from "./fcm.js";

/**
 * NOAA SWPC scales. Key "0" is the latest observed R/S/G levels; "1".."3"
 * are forecasts and "-1" is yesterday. ApiService.fetchGeomagneticStormLevel
 * reads the same key for the on-screen G level.
 */
const NOAA_SCALES_URL = "https://services.swpc.noaa.gov/products/noaa-scales.json";
/**
 * The 6-hour X-ray file, not the 1-day one. latestFlarePeak only ever looks
 * at FLARE_LOOKBACK_MS (90 minutes), so the day file was four times more
 * data than this reads: 651 KB and 0.93 ms of JSON.parse against 163 KB and
 * 0.22 ms, on a 10 ms budget.
 *
 * This is the alerting copy only. The app fetches xrays-1-day itself for the
 * flare history it draws, so nothing displayed gets shorter.
 */
const XRAY_URL = "https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json";
const UA = { "User-Agent": "AuroraTracker/1.0 (+https://auroratracker.app)" };

const STATE_KEY = "internal/alert-state.json";

/**
 * A repeat of the same level is held back this long. NOAA's G-scale moves on
 * 3-hour Kp boundaries, so this stops one storm re-announcing itself every
 * run while it holds.
 */
const STORM_COOLDOWN_MS = 3 * 60 * 60 * 1000;
/** Mirrors showSolarFlareAlert's dedup window. */
const FLARE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Only the last 90 minutes of X-ray flux counts as "now" — as in Dart. */
const FLARE_LOOKBACK_MS = 90 * 60 * 1000;

// ── scales (ports of lib/utils/geomagnetic_scale.dart) ──────────────────────

/**
 * Rank within the five levels NOAA defines. `G5+` ranks as G5 rather than
 * falling off the end — a bare indexOf returns -1 there, and a caller
 * comparing that against a threshold would swallow the strongest alert.
 */
export function gLevelRank(g) {
  const levels = ["G1", "G2", "G3", "G4", "G5"];
  const n = String(g).trim().toUpperCase();
  const i = levels.indexOf(n);
  if (i >= 0) return i;
  if (n === "G5+") return 4;
  return -1;
}

/** Mirrors ApiService._fluxToClass. */
export function fluxToClass(flux) {
  if (flux >= 1e-4) return `X${(flux / 1e-4).toFixed(1)}`;
  if (flux >= 1e-5) return `M${(flux / 1e-5).toFixed(1)}`;
  if (flux >= 1e-6) return `C${(flux / 1e-6).toFixed(1)}`;
  if (flux >= 1e-7) return `B${(flux / 1e-7).toFixed(1)}`;
  return `A${(flux / 1e-8).toFixed(1)}`;
}

/** Mirrors NotificationService._getFlarePriority. */
export function flareRank(cls) {
  const c = String(cls).charAt(0).toUpperCase();
  return { X: 4, M: 3, C: 2, B: 1 }[c] ?? 0;
}

// ── feeds ──────────────────────────────────────────────────────────────────

/**
 * NOAA's latest observed G level, e.g. `{ level: "G1", time: "2026-09-25T15:00:00Z" }`.
 * Returns null when the feed has no current G entry, so a malformed file is
 * "no sample" rather than a silent G0 that would clear the dedup state.
 */
export async function latestNoaaGScale() {
  const res = await fetch(NOAA_SCALES_URL, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`NOAA scales -> HTTP ${res.status}`);
  return parseNoaaGScale(await res.json());
}

/** Split out from the fetch so the tests can feed it a file. */
export function parseNoaaGScale(data) {
  const current = data?.["0"];
  const raw = current?.G?.Scale;
  if (raw === null || raw === undefined) return null;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  const date = String(current.DateStamp ?? "");
  const time = String(current.TimeStamp ?? "");
  return {
    level: n > 0 ? `G${n}` : "G0",
    time: date && time ? `${date}T${time}Z` : null,
  };
}

/** Peak GOES X-ray flux over the last 90 minutes, 0.1-0.8nm band. */
export async function latestFlarePeak() {
  const res = await fetch(XRAY_URL, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GOES XRS -> HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return null;

  const cutoff = Date.now() - FLARE_LOOKBACK_MS;
  let peakFlux = 0;
  let peakTime = null;

  for (const item of data) {
    if (!item || item.energy !== "0.1-0.8nm") continue;
    const raw = String(item.time_tag ?? "");
    const t = Date.parse(raw.endsWith("Z") ? raw : raw + "Z");
    if (Number.isNaN(t) || t < cutoff) continue;
    const flux = Number(item.flux);
    if (Number.isFinite(flux) && flux > peakFlux) {
      peakFlux = flux;
      peakTime = raw;
    }
  }
  if (peakFlux <= 0 || !peakTime) return null;
  return { flux: peakFlux, class: fluxToClass(peakFlux), time: peakTime };
}

// ── dedup state ────────────────────────────────────────────────────────────

export async function readState(bucket) {
  try {
    const obj = await bucket.get(STATE_KEY);
    if (!obj) return {};
    return (await obj.json()) ?? {};
  } catch {
    return {};
  }
}

async function writeState(bucket, state) {
  await bucket.put(STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}

// ── decisions ──────────────────────────────────────────────────────────────

/**
 * Decide whether NOAA's observed G level warrants a push.
 *
 * An escalation to a higher level fires immediately; the cooldown only
 * suppresses a repeat of the same level. Dropping to G0 clears the memory so
 * the next storm to cross the line is treated as new.
 */
export function decideStorm(sample, state, now = Date.now()) {
  if (!sample) return { send: false, reason: "no NOAA G-scale sample" };

  const level = sample.level;
  if (level === "G0") return { send: false, reason: "below storm level", clear: true };

  const rank = gLevelRank(level);
  if (rank < 0) return { send: false, reason: `unrecognised level ${level}` };

  const lastLevel = state.storm_level ?? null;
  const lastTime = state.storm_time ?? 0;
  const escalated = lastLevel === null || rank > gLevelRank(lastLevel);

  if (!escalated && now - lastTime < STORM_COOLDOWN_MS) {
    const mins = Math.round((now - lastTime) / 60000);
    return { send: false, reason: `${level} holding, ${mins}m into 180m cooldown` };
  }

  // Address every level at or below the observation. A device subscribed to
  // storm_g4 is deliberately not in this list for a G3.
  const topics = ["storm_g1", "storm_g2", "storm_g3", "storm_g4", "storm_g5"].slice(0, rank + 1);

  return {
    send: true,
    level,
    escalated,
    condition: topicCondition(topics),
    data: {
      event_type: "GST",
      level,
      source: "noaa_scales",
      observed_at: sample.time ?? new Date(now).toISOString(),
    },
  };
}

/**
 * Port of showSolarFlareAlert's dedup: readings within 2 hours are the same
 * flare event, and only an escalation to a higher class letter re-notifies.
 *
 * Sub-C flares are ignored entirely — C is the lowest threshold the settings
 * screen offers, so nothing below it has a subscriber.
 */
export function decideFlare(peak, state, now = Date.now()) {
  if (!peak) return { send: false, reason: "no flare peak" };

  const rank = flareRank(peak.class);
  if (rank < 2) return { send: false, reason: `${peak.class} below C` };

  const lastClass = state.flare_class ?? null;
  const lastTime = state.flare_time ?? 0;
  const withinWindow = now - lastTime < FLARE_WINDOW_MS;
  const escalated = lastClass === null || rank > flareRank(lastClass);

  if (withinWindow && !escalated) {
    return { send: false, reason: `${peak.class} same event as ${lastClass}` };
  }

  const topics = ["flare_c", "flare_m", "flare_x"].slice(0, rank - 1);

  return {
    send: true,
    level: peak.class,
    escalated,
    condition: topicCondition(topics),
    data: {
      event_type: "FLR",
      level: peak.class,
      flux: peak.flux.toExponential(2),
      observed_at: peak.time,
    },
  };
}

/**
 * Port of NotificationService._handleCmeNotification.
 *
 * DONKI bulletins are prose, so the original matches on the text and this
 * keeps exactly the same substrings -- diverging here would mean the phone
 * and the server disagreed about what counts as an Earth-directed CME.
 *
 *   Earth-directed : body mentions earth, arrival or impact
 *   Significant    : additionally carries a watch, warning or alert
 *
 * Dedup is by DONKI's messageID rather than by time: these are reissued and
 * revised, and the same event can appear repeatedly with the same ID.
 *
 * On first run every ID is recorded and nothing is sent. Without that, the
 * first tick would fire a notification for each of the last two days of
 * bulletins at once -- the same guard the client has.
 */
export function decideCme(notifications, state, now = Date.now()) {
  if (!Array.isArray(notifications)) {
    return { send: false, reason: "no donki notifications available" };
  }

  const cmes = notifications.filter(
    (n) => n && String(n.messageType ?? "").toUpperCase() === "CME" && n.messageID
  );
  if (cmes.length === 0) return { send: false, reason: "no CME bulletins" };

  const seen = Array.isArray(state.cme_seen) ? state.cme_seen : null;
  if (seen === null) {
    return {
      send: false,
      reason: `first run — seeding ${cmes.length} ids`,
      seed: cmes.map((n) => String(n.messageID)),
    };
  }

  const seenSet = new Set(seen);
  const fresh = cmes.filter((n) => !seenSet.has(String(n.messageID)));
  if (fresh.length === 0) return { send: false, reason: "no new CME bulletins" };

  // Newest first, so the alert describes the most recent bulletin when
  // several arrive in one tick.
  fresh.sort((a, b) => String(b.messageIssueTime ?? "").localeCompare(String(a.messageIssueTime ?? "")));

  let chosen = null;
  let significant = false;
  for (const n of fresh) {
    const body = String(n.messageBody ?? "").toLowerCase();
    const earthDirected =
      body.includes("earth") || body.includes("arrival") || body.includes("impact");
    if (!earthDirected) continue;
    const isSig =
      body.includes("watch") || body.includes("warning") || body.includes("alert");
    if (chosen === null || (isSig && !significant)) {
      chosen = n;
      significant = isSig;
    }
    if (significant) break;
  }

  // Every fresh id is recorded even when nothing is sent, so a bulletin that
  // is not Earth-directed is not re-examined on every subsequent tick.
  const seenNext = fresh.map((n) => String(n.messageID));

  if (chosen === null) {
    return { send: false, reason: `${fresh.length} new, none Earth-directed`, seenNext };
  }

  // "significant" subscribers want only classified bulletins; "all" wants
  // every Earth-directed one. Same at-or-below addressing as storms.
  const topics = significant ? ["cme_all", "cme_significant"] : ["cme_all"];

  return {
    send: true,
    level: significant ? "significant" : "all",
    significant,
    condition: topicCondition(topics),
    seenNext,
    data: {
      event_type: "CME",
      level: significant ? "significant" : "all",
      message_id: String(chosen.messageID),
      observed_at: String(chosen.messageIssueTime ?? new Date(now).toISOString()),
    },
  };
}

/** Keep the seen-id list bounded; DONKI issues a handful of CMEs a day. */
const CME_SEEN_CAP = 200;

export async function commitState(bucket, state, storm, flare, now = Date.now(), cme = null) {
  const next = { ...state };
  if (storm?.clear) {
    delete next.storm_level;
    delete next.storm_time;
  }
  if (storm?.send) {
    next.storm_level = storm.level;
    next.storm_time = now;
  }
  if (flare?.send) {
    next.flare_class = flare.level;
    next.flare_time = now;
  }
  // Seeding and sending both record ids. So does a non-Earth-directed
  // bulletin, so it is not re-read on every tick for the next two days.
  const newIds = cme?.seed ?? cme?.seenNext ?? null;
  if (newIds && newIds.length > 0) {
    const merged = [...(Array.isArray(next.cme_seen) ? next.cme_seen : []), ...newIds];
    next.cme_seen = merged.slice(-CME_SEEN_CAP);
  } else if (cme && !Array.isArray(next.cme_seen)) {
    next.cme_seen = [];
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) {
    await writeState(bucket, next);
  }
  return next;
}
