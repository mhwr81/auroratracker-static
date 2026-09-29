/**
 * The multi-day hemispheric power archive, built on Cloudflare.
 *
 * This replaces the GitHub Action that committed
 * data/hemispheric_power_history.json. That job only ran a handful of times a
 * day, was delayed 20-110 min by GitHub's free-tier scheduler, sometimes
 * skipped runs outright, and needed three staggered near-midnight runs to
 * catch rows that exist only in the previous day's NOAA file -- which it
 * still missed often enough that most archived days start at ~01:0x.
 *
 * The fast tier already captures the NOAA file every 2 minutes into a 30-hour
 * rolling window (internal/hemi.json), so nothing is ever lost across the
 * 00:00 UTC reset. This folds that window into the archive it last wrote,
 * trims it to DAYS_TO_KEEP, and writes it in exactly the shape the Action
 * wrote (schema 2), so the app needs no changes.
 *
 * It runs on its own cron (CRON_HEMI) and writes its own object,
 * v1/hemi_history.json. It first ran inside the slow tier, which made that
 * tier parse the solar wind state and a 120 KB slow.json on every run and
 * took it from ~4 ms to 8-13 ms of a 10 ms budget. The slow tier now splices
 * this object's text into slow.json's hemi_history without parsing it.
 *
 * The merge mirrors the Action's Python script: bucket rows by their own
 * valid date, union by valid time with fresh rows winning, and let real rows
 * supersede migrated (pre-schema-2) ones inside the freshly covered span.
 */

import { readHemiState } from "./series.js";

export const SCHEMA = 2;
export const ARCHIVE_KEY = "v1/hemi_history.json";
export const ARCHIVE_CACHE_CONTROL = "public, max-age=1800, stale-while-revalidate=3600";
const DAYS_TO_KEEP = 3;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * @param prevArchive the hemi_history last published in slow.json (or null)
 * @param fresh       rows { time, obs_time, north, south } from the 30 h window
 * @returns the new archive, or null when there is nothing to publish
 */
export function mergeArchive(prevArchive, fresh, nowMs) {
  const now = iso(nowMs);
  const days = { ...(prevArchive?.schema === SCHEMA ? prevArchive.days : {}) };

  const byDate = {};
  for (const r of fresh) {
    if (typeof r?.time !== "string") continue;
    (byDate[r.time.slice(0, 10)] ??= []).push({
      time: r.time, obs_time: r.obs_time, north: r.north, south: r.south,
    });
  }

  for (const [date, rows] of Object.entries(byDate)) {
    rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const lo = rows[0].time, hi = rows[rows.length - 1].time;
    const merged = new Map();
    for (const r of days[date]?.readings ?? []) {
      if (r.migrated && lo <= r.time && r.time <= hi) continue;
      merged.set(r.time, r);
    }
    for (const r of rows) merged.set(r.time, r);
    days[date] = {
      date,
      captured_at: now,
      readings: [...merged.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)),
    };
  }

  const cutoff = iso(nowMs - DAYS_TO_KEEP * 86400_000).slice(0, 10);
  const kept = {};
  for (const date of Object.keys(days).sort()) if (date >= cutoff) kept[date] = days[date];
  if (Object.keys(kept).length === 0) return null;

  return { updated_at: now, schema: SCHEMA, days: kept };
}

/**
 * Fresh archive for this slow run, or null when the capture window could not
 * be read -- the caller then keeps the previous archive and marks it stale.
 */
export async function buildHemiArchive(bucket, prevArchive, nowMs = Date.now()) {
  const state = await readHemiState(bucket);
  if (state.cold || state.hemi.length === 0) {
    console.log("hemi archive: capture window unavailable, keeping previous archive");
    return null;
  }
  return mergeArchive(prevArchive, state.hemi, nowMs);
}

/**
 * The archive as last written. Returns null when there is none yet (the
 * caller migrates it out of slow.json) and throws when R2 could not be read,
 * so a transient failure skips the run instead of rebuilding from the 30-hour
 * window and silently cutting three days of history down to it.
 */
async function previousArchive(bucket) {
  const obj = await bucket.get(ARCHIVE_KEY);
  if (obj) return (await obj.json()) ?? null;
  // One-time migration: before this object existed the archive lived only in
  // slow.json. A read failure here throws for the same reason as above.
  const slow = await bucket.get("v1/slow.json");
  return slow ? ((await slow.json())?.hemi_history ?? null) : null;
}

/** The CRON_HEMI job. Writes nothing when there is nothing new to fold in. */
export async function publishHemiArchive(bucket, nowMs = Date.now()) {
  let prev;
  try {
    prev = await previousArchive(bucket);
  } catch (e) {
    console.log(`hemi archive: previous archive unreadable (${e.message}); skipping to protect it`);
    return { written: false };
  }
  const archive = await buildHemiArchive(bucket, prev, nowMs);
  if (!archive) return { written: false };

  const body = JSON.stringify(archive);
  const days = Object.keys(archive.days).length;
  await bucket.put(ARCHIVE_KEY, body, {
    httpMetadata: { contentType: "application/json", cacheControl: ARCHIVE_CACHE_CONTROL },
    // Read by the slow tier, which embeds this object without parsing it.
    customMetadata: { days: String(days), updated_at: archive.updated_at },
  });
  console.log(`wrote ${ARCHIVE_KEY} ${body.length}B — ${days} days`);
  return { written: true, body, days, archive };
}
