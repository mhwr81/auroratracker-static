/**
 * The hemi archive merge that replaced the GitHub capture Action.
 *
 * The Action's behaviour is the contract here: the app reads slow.json's
 * hemi_history exactly as it read the committed file, so anything this merge
 * does differently shows up as a gap or a doubled bar in the chart. Run with:
 *
 *   node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeArchive, buildHemiArchive, publishHemiArchive, ARCHIVE_KEY, SCHEMA } from "../src/hemi_archive.js";
import { publishSlow, slowBody } from "../src/slow.js";

const NOW = Date.parse("2026-09-28T19:00:00Z");
const row = (time, n = 10, s = 10, extra = {}) => ({ time, obs_time: time, north: n, south: s, ...extra });
const archive = (days) => ({
  updated_at: "2026-09-28T12:00:00Z",
  schema: SCHEMA,
  days: Object.fromEntries(Object.entries(days).map(([d, readings]) => [d, { date: d, captured_at: "x", readings }])),
});
const times = (a, d) => a.days[d].readings.map((r) => r.time);

test("rows are bucketed by their own valid date, across midnight", () => {
  const out = mergeArchive(null, [row("2026-09-27T23:55:00Z"), row("2026-09-28T00:05:00Z")], NOW);
  assert.deepEqual(Object.keys(out.days), ["2026-09-27", "2026-09-28"]);
  assert.deepEqual(times(out, "2026-09-27"), ["2026-09-27T23:55:00Z"]);
  assert.deepEqual(times(out, "2026-09-28"), ["2026-09-28T00:05:00Z"]);
  assert.equal(out.schema, SCHEMA);
  assert.equal(out.updated_at, "2026-09-28T19:00:00Z");
});

test("union by valid time: history is kept, fresh rows win, no duplicates", () => {
  const prev = archive({ "2026-09-28": [row("2026-09-28T01:00:00Z", 5), row("2026-09-28T02:00:00Z", 5)] });
  const out = mergeArchive(prev, [row("2026-09-28T02:00:00Z", 9), row("2026-09-28T03:00:00Z", 9)], NOW);
  const rs = out.days["2026-09-28"].readings;
  assert.deepEqual(rs.map((r) => r.time), ["2026-09-28T01:00:00Z", "2026-09-28T02:00:00Z", "2026-09-28T03:00:00Z"]);
  assert.deepEqual(rs.map((r) => r.north), [5, 9, 9]);
});

test("days not touched by the fresh window are carried forward unchanged", () => {
  const prev = archive({ "2026-09-26": [row("2026-09-26T12:00:00Z")] });
  const out = mergeArchive(prev, [row("2026-09-28T12:00:00Z")], NOW);
  assert.deepEqual(out.days["2026-09-26"], prev.days["2026-09-26"]);
});

test("migrated rows give way inside the fresh span and survive outside it", () => {
  const prev = archive({
    "2026-09-28": [
      row("2026-09-28T00:30:00Z", 1, 1, { migrated: true }),
      row("2026-09-28T02:00:00Z", 1, 1, { migrated: true }),
    ],
  });
  const out = mergeArchive(prev, [row("2026-09-28T01:00:00Z"), row("2026-09-28T03:00:00Z")], NOW);
  assert.deepEqual(times(out, "2026-09-28"), ["2026-09-28T00:30:00Z", "2026-09-28T01:00:00Z", "2026-09-28T03:00:00Z"]);
});

test("days older than three are trimmed", () => {
  const prev = archive({ "2026-09-24": [row("2026-09-24T12:00:00Z")], "2026-09-25": [row("2026-09-25T12:00:00Z")] });
  const out = mergeArchive(prev, [row("2026-09-28T12:00:00Z")], NOW);
  assert.deepEqual(Object.keys(out.days), ["2026-09-25", "2026-09-28"]);
});

test("an archive in another schema is not merged into", () => {
  const prev = { ...archive({ "2026-09-28": [row("2026-09-28T01:00:00Z")] }), schema: 1 };
  const out = mergeArchive(prev, [row("2026-09-28T05:00:00Z")], NOW);
  assert.deepEqual(times(out, "2026-09-28"), ["2026-09-28T05:00:00Z"]);
});

test("nothing fresh and nothing kept is null, not an empty archive", () => {
  assert.equal(mergeArchive(null, [], NOW), null);
});

test("a cold or unreadable capture window keeps the previous archive (null)", async () => {
  const missing = { get: async () => null };
  const broken = { get: async () => { throw new Error("R2 down"); } };
  const prev = archive({ "2026-09-28": [row("2026-09-28T01:00:00Z")] });
  assert.equal(await buildHemiArchive(missing, prev, NOW), null);
  assert.equal(await buildHemiArchive(broken, prev, NOW), null);
});

test("reads the capture window from R2 state", async () => {
  const state = { hemi: [row("2026-09-28T18:00:00Z", 42)] };
  const bucket = { get: async () => ({ text: async () => JSON.stringify(state) }) };
  const out = await buildHemiArchive(bucket, null, NOW);
  assert.equal(out.days["2026-09-28"].readings[0].north, 42);
});

// A minimal R2 stand-in: string bodies, customMetadata kept, puts recorded.
function memBucket(init = {}, { failGet = null } = {}) {
  const objs = new Map(Object.entries(init).map(([k, v]) => [k, { body: JSON.stringify(v), meta: {} }]));
  const puts = [];
  return {
    objs, puts,
    async get(k) {
      if (failGet?.(k)) throw new Error("R2 down");
      const o = objs.get(k);
      return o ? { text: async () => o.body, json: async () => JSON.parse(o.body), customMetadata: o.meta } : null;
    },
    async put(k, body, opts = {}) {
      puts.push(k);
      objs.set(k, { body, meta: opts.customMetadata ?? {} });
    },
  };
}

test("the archive job migrates the archive out of slow.json on its first run", async () => {
  const prev = archive({ "2026-09-27": [row("2026-09-27T12:00:00Z", 7)] });
  const bucket = memBucket({
    "v1/slow.json": { hemi_history: prev },
    "internal/hemi.json": { hemi: [row("2026-09-28T18:00:00Z", 42)] },
  });
  const r = await publishHemiArchive(bucket, NOW);
  assert.equal(r.written, true);
  const out = JSON.parse(bucket.objs.get(ARCHIVE_KEY).body);
  assert.deepEqual(Object.keys(out.days), ["2026-09-27", "2026-09-28"]);
  assert.equal(bucket.objs.get(ARCHIVE_KEY).meta.days, "2");
});

test("the archive job skips, rather than rebuilds, when the archive is unreadable", async () => {
  const bucket = memBucket(
    { "internal/hemi.json": { hemi: [row("2026-09-28T18:00:00Z")] } },
    { failGet: (k) => k === ARCHIVE_KEY }
  );
  assert.equal((await publishHemiArchive(bucket, NOW)).written, false);
  assert.deepEqual(bucket.puts, []);
});

test("slow.json carries the archive verbatim, spliced in as hemi_history", () => {
  const a = archive({ "2026-09-28": [row("2026-09-28T01:00:00Z")] });
  const slow = { schema: "v1", donki: { notifications: [] }, counts: { hemi_days: 1 } };
  assert.deepEqual(JSON.parse(slowBody(slow, JSON.stringify(a))), { ...slow, hemi_history: a });
  assert.equal(JSON.parse(slowBody(slow, null)).hemi_history, null);
});

test("the slow tier carries the old hemi_history forward when no archive can be built yet", async () => {
  const a = archive({ "2026-09-27": [row("2026-09-27T12:00:00Z")] });
  const bucket = memBucket({ "v1/slow.json": { donki: { notifications: [1] }, hemi_history: a } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]", { status: 200 });
  try {
    await publishSlow({ BUCKET: bucket, NASA_API_KEY: "k" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(JSON.parse(bucket.objs.get("v1/slow.json").body).hemi_history, a);
  assert.deepEqual(JSON.parse(bucket.objs.get("internal/donki.json").body).notifications, []);
});
