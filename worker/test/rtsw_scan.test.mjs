/**
 * The repair tier's active-row scan must return exactly what a full parse
 * followed by the active-source selection would. It exists only to save CPU;
 * any divergence would silently rewrite a day of solar wind. Run with:
 *
 *   node --test test/*.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeRecordsFromText } from "../src/index.js";

// NOAA's own spelling: one line, ", " and ": " separators, newest first.
const rec = (t, source, active, bz) =>
  `{"time_tag": "${t}", "active": ${active}, "source": "${source}", "bt": 3.5, "bz_gsm": ${bz}, "range": null}`;
const feed = (...rows) => `[${rows.join(", ")}]`;

const T1 = "2026-09-28T21:01:00", T2 = "2026-09-28T21:02:00", T3 = "2026-09-28T21:03:00";

test("keeps only the active spacecraft, oldest first", () => {
  const text = feed(
    rec(T3, "SOLAR1", true, -1), rec(T3, "ACE", false, 9), rec(T3, "IMAP", false, 9),
    rec(T2, "SOLAR1", true, -2), rec(T2, "ACE", false, 9),
    rec(T1, "SOLAR1", true, -3), rec(T1, "IMAP", false, 9),
  );
  const out = activeRecordsFromText(text);
  assert.deepEqual(out.map((r) => [r.time_tag, r.source, r.bz_gsm]), [
    [T1, "SOLAR1", -3], [T2, "SOLAR1", -2], [T3, "SOLAR1", -1],
  ]);
});

test("matches the full parse field for field", () => {
  const text = feed(rec(T2, "SOLAR1", true, -2), rec(T2, "ACE", false, 1), rec(T1, "SOLAR1", true, -3));
  const full = JSON.parse(text).filter((r) => r.active).reverse();
  assert.deepEqual(activeRecordsFromText(text), full);
});

test("no active flag anywhere falls back to the first source, as before", () => {
  const text = feed(rec(T2, "ACE", false, 1), rec(T2, "IMAP", false, 2), rec(T1, "ACE", false, 3));
  const out = activeRecordsFromText(text);
  assert.deepEqual(out.map((r) => [r.time_tag, r.source]), [[T1, "ACE"], [T2, "ACE"]]);
});

test("a shape the scan cannot slice falls back to the full parse", () => {
  // A nested object puts a "}" inside the record, so the slice is invalid JSON.
  const text = `[{"time_tag": "${T1}", "meta": {"x": 1}, "active": true, "source": "SOLAR1", "bz_gsm": -3}]`;
  const out = activeRecordsFromText(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].bz_gsm, -3);
});

test("tolerates compact spelling", () => {
  const text = `[{"time_tag":"${T1}","active":true,"source":"SOLAR1","bz_gsm":-3},{"time_tag":"${T1}","active":false,"source":"ACE","bz_gsm":1}]`;
  assert.deepEqual(activeRecordsFromText(text).map((r) => r.source), ["SOLAR1"]);
});
