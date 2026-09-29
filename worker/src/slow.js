/**
 * The slow tier: feeds that move on the order of hours, and the two sources
 * that would actually break at scale rather than merely cost bandwidth.
 *
 * NASA DONKI is rate limited to 1,000 requests/hour PER KEY, and the app
 * shipped one key compiled into every APK -- so the ceiling was shared by
 * every install and was breached at a few hundred of them. Fetching it here
 * makes that a fixed 48 requests a day regardless of userbase, and lets the
 * key come out of the binary entirely.
 *
 * slow.json also carries the hemispheric power archive as hemi_history,
 * because that is where the app reads it. The archive is built by its own
 * cron (hemi_archive.js) and spliced in here as raw text: parsing ~100 KB of
 * it only to serialise it straight back out is what pushed this tier past
 * 10 ms when the archive was first built here.
 *
 * The DONKI feeds are republished VERBATIM. These payloads are small enough that
 * re-parsing them would buy nothing and risk the server and the app
 * disagreeing about shape -- the failure mode that is hardest to notice.
 */

import { ARCHIVE_KEY, publishHemiArchive } from "./hemi_archive.js";

const DONKI = "https://api.nasa.gov/DONKI";

const UA = { "User-Agent": "AuroraTracker/1.0 (+https://auroratracker.app)" };

export const SLOW_KEY = "v1/slow.json";
export const SLOW_CACHE_CONTROL = "public, max-age=1800, stale-while-revalidate=3600";

// The cadence gate that used to live here is gone. This tier has its own cron
// now ("2,32 * * * *" — CRON_SLOW in index.js) rather than riding the
// 3-minute live tick and checking the clock, so it runs twice an hour in its
// own invocation with its own CPU budget instead of borrowing the bundle's.

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * DONKI times out and 503s often enough that a single attempt is not a fair
 * test of whether data exists. Measured over three consecutive runs, every
 * section failed at least once and every section also succeeded at least
 * once. One retry after a short pause turns most of that into a success.
 */
async function getJsonRetry(url, label, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getJson(url, label);
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
}

async function getJson(url, label) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (res.status === 429) throw new Error(`${label}: rate limited by upstream`);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);

  // DONKI answers "nothing in that window" with an EMPTY BODY, not with [].
  // res.json() throws on that, which would otherwise be indistinguishable
  // from a real failure and would send every device back to NASA directly
  // during exactly the quiet stretches when nothing is happening.
  const text = (await res.text()).trim();
  if (text === "") return [];
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: body is not JSON (${text.slice(0, 80)})`);
  }
}

/**
 * The DONKI sections as last fetched, kept apart from slow.json.
 *
 * Two readers need them without the hemi archive slow.json also carries: this
 * tier, so a section that fails this run can keep serving the copy that
 * worked, and the alerts tier, which checks the CME bulletins every 4
 * minutes. Both used to parse all ~120 KB of slow.json to get at ~25 KB.
 */
export const DONKI_KEY = "internal/donki.json";

/**
 * The last DONKI sections, or null when there are none. Falls back to
 * slow.json's copy once, for the first run after this object was introduced.
 * A read failure returns null too: nothing here is destructive, the worst
 * case is one run without a fallback.
 */
export async function readDonki(bucket) {
  try {
    const obj = await bucket.get(DONKI_KEY);
    if (obj) return (await obj.json()) ?? null;
    const slow = await bucket.get(SLOW_KEY);
    return slow ? ((await slow.json())?.donki ?? null) : null;
  } catch (e) {
    console.log(`previous DONKI read failed: ${e.message}`);
    return null;
  }
}

/** A hemi archive older than this is flagged stale; it is rebuilt every ~30 min. */
const ARCHIVE_STALE_MS = 90 * 60_000;

/**
 * The hemi archive's stored JSON, unparsed, with the day count and age its
 * writer left in customMetadata. `text` is null when there is no archive yet.
 * Throws when R2 could not be read -- publishing without the archive would
 * drop it from slow.json, which is worse than skipping one slow run.
 */
async function readArchiveText(bucket) {
  const obj = await bucket.get(ARCHIVE_KEY);
  if (!obj) return { text: null, days: null, updatedAt: null };
  const days = Number(obj.customMetadata?.days);
  return {
    text: await obj.text(),
    days: Number.isFinite(days) ? days : null,
    updatedAt: obj.customMetadata?.updated_at ?? null,
  };
}

/**
 * Build the slow bundle. Returns it WITHOUT hemi_history, plus the archive's
 * raw text for publishSlow to splice in -- see the header note.
 */
export async function buildSlow(env) {
  // Trimmed: a secret set by piping through a shell picks up a trailing
  // newline, and NASA answers a malformed key with a 403 that says nothing
  // useful. DEMO_KEY is only a last resort -- it is rate limited per IP and
  // Cloudflare egress IPs are shared, so it is effectively always exhausted.
  const key = (env.NASA_API_KEY || "").trim() || "DEMO_KEY";
  const now = new Date();
  const since = (days) => ymd(new Date(now.getTime() - days * 86400_000));

  // Windows chosen to cover what the app asks for. FLR is queried per flare
  // peak with a +/-1 day window, so a 7-day publication covers any peak the
  // 90-minute GOES lookback can surface, and the app filters locally.
  const errors = [];
  const attempt = (p) =>
    p.catch((e) => {
      console.log(e.message);
      errors.push(e.message);
      return null;
    });

  const [notifications, flr, enlil, prev, arch] = await Promise.all([
    attempt(getJsonRetry(`${DONKI}/notifications?api_key=${key}&type=all&startDate=${since(2)}&endDate=${ymd(now)}`, "DONKI notifications")),
    attempt(getJsonRetry(`${DONKI}/FLR?api_key=${key}&startDate=${since(7)}&endDate=${ymd(now)}`, "DONKI FLR")),
    attempt(getJsonRetry(`${DONKI}/WSAEnlilSimulations?api_key=${key}&startDate=${since(14)}&endDate=${ymd(now)}`, "DONKI ENLIL")),
    env.BUCKET ? readDonki(env.BUCKET) : null,
    env.BUCKET ? readArchiveText(env.BUCKET) : { text: null, days: null, updatedAt: null },
  ]);

  // A failed section keeps whatever was published last rather than becoming
  // null. DONKI drops out for minutes at a time; without this the app would
  // see an empty CME panel and fall back to querying NASA per device --
  // hammering the very endpoint that is already struggling.
  const keep = (fresh, name) => {
    if (fresh !== null && fresh !== undefined) return { value: fresh, stale: false };
    const old = prev?.[name];
    return old !== undefined && old !== null
      ? { value: old, stale: true }
      : { value: null, stale: false };
  };

  const n = keep(notifications, "notifications");
  const f = keep(flr, "flr");
  const e = keep(enlil, "enlil");
  const archiveAge = arch.updatedAt ? now.getTime() - Date.parse(arch.updatedAt) : NaN;

  const slow = {
    schema: "v1",
    generated: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    // Which sections are being served from a previous run.
    stale: Object.entries({
      notifications: n.stale, flr: f.stale, enlil: e.stale,
      hemi_history: archiveAge > ARCHIVE_STALE_MS,
    }).filter(([, v]) => v).map(([k]) => k),
    // A null section means that fetch failed this run. Callers must treat it
    // as "go and get it yourself", never as "there is no data".
    donki: { notifications: n.value, flr: f.value, enlil: e.value },
    counts: {
      notifications: Array.isArray(n.value) ? n.value.length : null,
      flr: Array.isArray(f.value) ? f.value.length : null,
      enlil: Array.isArray(e.value) ? e.value.length : null,
      hemi_days: arch.text ? arch.days : null,
    },
    errors,
  };
  return { slow, hemiText: arch.text };
}

/**
 * slow.json's text: the bundle with the archive's stored JSON appended as
 * hemi_history, verbatim. The archive was written by JSON.stringify, so it is
 * already valid JSON and splicing it cannot produce a malformed document.
 */
export function slowBody(slow, hemiText) {
  return `${JSON.stringify(slow).slice(0, -1)},"hemi_history":${hemiText ?? "null"}}`;
}

/**
 * Writes only when at least one section came back. A bundle of four nulls
 * would replace a good one with nothing, and every reader would fall back to
 * hitting upstream directly -- the exact load this tier exists to prevent.
 */
export async function publishSlow(env) {
  const built = await buildSlow(env);
  const { slow } = built;
  let { hemiText } = built;

  // One-time migration: until the hemi archive cron has run once, the
  // archive exists only inside slow.json. Build it now, and failing that
  // carry the old copy forward, rather than publish a slow.json without it.
  if (hemiText === null) {
    console.log(`${ARCHIVE_KEY} missing; building it before the slow bundle`);
    const a = await publishHemiArchive(env.BUCKET);
    if (a.written) {
      hemiText = a.body;
      slow.counts.hemi_days = a.days;
    } else {
      const old = await env.BUCKET.get(SLOW_KEY);
      const h = old ? (await old.json())?.hemi_history : null;
      if (h) hemiText = JSON.stringify(h);
    }
  }

  const live = Object.values(slow.counts).some((v) => v !== null);
  if (!live) {
    console.log(`REFUSED to write ${SLOW_KEY}: every section failed`);
    return { written: false, slow };
  }

  const body = slowBody(slow, hemiText);
  await Promise.all([
    env.BUCKET.put(SLOW_KEY, body, {
      httpMetadata: { contentType: "application/json", cacheControl: SLOW_CACHE_CONTROL },
    }),
    env.BUCKET.put(DONKI_KEY, JSON.stringify(slow.donki), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    }),
  ]);
  console.log(`wrote ${SLOW_KEY} ${body.length}B — ${JSON.stringify(slow.counts)}`);
  return { written: true, bytes: body.length, slow };
}
