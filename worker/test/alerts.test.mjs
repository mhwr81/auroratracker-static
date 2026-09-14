/**
 * Exercises the alert decisions against synthetic conditions.
 *
 * Real storms are rare and the quiet-time path proves almost nothing: every
 * branch that matters — topic addressing, the cooldown, escalation, and the
 * G0 reset — only runs when something is actually happening. Run with:
 *
 *   node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStorm, decideFlare, decideCme, gLevelForKp, gLevelRank, fluxToClass } from "../src/alerts.js";

const HOUR = 3600_000;
const T0 = Date.parse("2026-09-14T00:00:00Z");
const hp30 = (kp) => ({ kp, time: "2026-09-14T00:00:00Z" });
const flare = (flux) => ({ flux, class: fluxToClass(flux), time: "2026-09-14T00:00:00Z" });

test("G-scale boundaries match the Dart", () => {
  assert.equal(gLevelForKp(4.99), "G0");
  assert.equal(gLevelForKp(5), "G1");
  assert.equal(gLevelForKp(6), "G2");
  assert.equal(gLevelForKp(7), "G3");
  assert.equal(gLevelForKp(8), "G4");
  assert.equal(gLevelForKp(9), "G5");
  assert.equal(gLevelForKp(11.33), "G5+"); // Gannon storm peak
  assert.equal(gLevelRank("G5+"), 4, "G5+ must rank as G5, never -1");
});

test("a storm addresses its level and every level below, never above", () => {
  const d = decideStorm(hp30(7.2), {}, T0);
  assert.equal(d.send, true);
  assert.equal(d.level, "G3");
  assert.equal(
    d.condition,
    "'storm_g1' in topics || 'storm_g2' in topics || 'storm_g3' in topics"
  );
  assert.ok(!d.condition.includes("storm_g4"), "a G4 subscriber must not be woken by a G3");
});

test("G1 addresses only G1 subscribers", () => {
  const d = decideStorm(hp30(5.1), {}, T0);
  assert.equal(d.condition, "'storm_g1' in topics");
});

test("G5+ still addresses all five levels", () => {
  const d = decideStorm(hp30(11.33), {}, T0);
  assert.equal(d.send, true);
  assert.equal(d.level, "G5+");
  assert.equal(d.condition.split("||").length, 5);
});

test("the same level inside the cooldown is suppressed", () => {
  const state = { storm_level: "G3", storm_time: T0 };
  const d = decideStorm(hp30(7.2), state, T0 + 2 * HOUR);
  assert.equal(d.send, false);
  assert.match(d.reason, /cooldown/);
});

test("the same level after the cooldown fires again", () => {
  const state = { storm_level: "G3", storm_time: T0 };
  const d = decideStorm(hp30(7.2), state, T0 + 3.5 * HOUR);
  assert.equal(d.send, true);
  assert.equal(d.escalated, false);
});

test("escalation beats the cooldown", () => {
  const state = { storm_level: "G3", storm_time: T0 };
  const d = decideStorm(hp30(8.4), state, T0 + 10 * 60_000);
  assert.equal(d.send, true);
  assert.equal(d.escalated, true);
  assert.equal(d.level, "G4");
});

test("a wobble down does not re-notify", () => {
  const state = { storm_level: "G4", storm_time: T0 };
  const d = decideStorm(hp30(7.1), state, T0 + 30 * 60_000);
  assert.equal(d.send, false, "G3 after G4 is the same storm settling, not a new one");
});

test("dropping to G0 clears the memory so the next storm is new", () => {
  const quiet = decideStorm(hp30(1.667), { storm_level: "G3", storm_time: T0 }, T0 + HOUR);
  assert.equal(quiet.send, false);
  assert.equal(quiet.clear, true);

  // after commitState has cleared it, a fresh G2 fires despite being lower
  const fresh = decideStorm(hp30(6.2), {}, T0 + 2 * HOUR);
  assert.equal(fresh.send, true);
  assert.equal(fresh.level, "G2");
});

test("flare classes map to the right topics", () => {
  assert.equal(decideFlare(flare(2.3e-5), {}, T0).condition, "'flare_c' in topics || 'flare_m' in topics");
  assert.equal(
    decideFlare(flare(1.1e-4), {}, T0).condition,
    "'flare_c' in topics || 'flare_m' in topics || 'flare_x' in topics"
  );
  assert.equal(decideFlare(flare(4.0e-6), {}, T0).condition, "'flare_c' in topics");
});

test("sub-C flares never send — nothing subscribes below C", () => {
  assert.equal(decideFlare(flare(3.8e-7), {}, T0).send, false); // B3.8, today's real reading
  assert.equal(decideFlare(flare(5e-9), {}, T0).send, false);
});

test("a second reading of the same flare is one event", () => {
  const state = { flare_class: "M2.3", flare_time: T0 };
  const d = decideFlare(flare(2.1e-5), state, T0 + 30 * 60_000);
  assert.equal(d.send, false);
  assert.match(d.reason, /same event/);
});

test("a flare escalating class re-notifies inside the window", () => {
  const state = { flare_class: "M2.3", flare_time: T0 };
  const d = decideFlare(flare(1.4e-4), state, T0 + 20 * 60_000);
  assert.equal(d.send, true);
  assert.equal(d.level, "X1.4");
  assert.equal(d.escalated, true);
});

test("a new flare after the window is a new event", () => {
  const state = { flare_class: "M2.3", flare_time: T0 };
  const d = decideFlare(flare(1.9e-5), state, T0 + 2.5 * HOUR);
  assert.equal(d.send, true);
});

test("flux classification matches ApiService._fluxToClass", () => {
  assert.equal(fluxToClass(1.0e-4), "X1.0");
  assert.equal(fluxToClass(2.34e-5), "M2.3");
  assert.equal(fluxToClass(9.99e-6), "C10.0");
  assert.equal(fluxToClass(3.8309963201754726e-7), "B3.8");
});

// ── CME bulletins ──────────────────────────────────────────────────────────

const cme = (id, body, type = "CME") => ({
  messageID: id,
  messageType: type,
  messageBody: body,
  messageIssueTime: "2026-09-14T00:00:00Z",
});

test("first run seeds every id and sends nothing", () => {
  const d = decideCme([cme("a", "Earth impact expected, WATCH issued")], {}, T0);
  assert.equal(d.send, false, "a fresh install must not fire two days of backlog at once");
  assert.deepEqual(d.seed, ["a"]);
});

test("a significant Earth-directed CME reaches both tiers", () => {
  const state = { cme_seen: [] };
  const d = decideCme([cme("a", "CME arrival expected. Geomagnetic Storm WARNING.")], state, T0);
  assert.equal(d.send, true);
  assert.equal(d.level, "significant");
  assert.equal(d.condition, "'cme_all' in topics || 'cme_significant' in topics");
});

test("Earth-directed but unclassified reaches only the all tier", () => {
  const state = { cme_seen: [] };
  const d = decideCme([cme("a", "CME observed, possible Earth impact in 48 hours")], state, T0);
  assert.equal(d.send, true);
  assert.equal(d.level, "all");
  assert.equal(d.condition, "'cme_all' in topics");
  assert.ok(!d.condition.includes("cme_significant"),
    "a significant-only subscriber must not be woken by an unclassified bulletin");
});

test("a CME not directed at Earth never sends", () => {
  const state = { cme_seen: [] };
  const d = decideCme([cme("a", "CME observed off the west limb, no significant effects")], state, T0);
  assert.equal(d.send, false);
  assert.deepEqual(d.seenNext, ["a"], "still recorded, or it is re-examined every tick");
});

test("an already-seen bulletin is not re-sent", () => {
  const state = { cme_seen: ["a"] };
  const d = decideCme([cme("a", "Earth impact WARNING")], state, T0);
  assert.equal(d.send, false);
  assert.match(d.reason, /no new/);
});

test("non-CME message types are ignored", () => {
  const state = { cme_seen: [] };
  const d = decideCme([cme("a", "Earth impact WARNING", "FLR")], state, T0);
  assert.equal(d.send, false);
});

test("a significant bulletin wins over an unclassified one in the same batch", () => {
  const state = { cme_seen: [] };
  const d = decideCme(
    [cme("a", "possible Earth impact"), cme("b", "Earth arrival, ALERT issued")],
    state,
    T0
  );
  assert.equal(d.send, true);
  assert.equal(d.significant, true);
  assert.deepEqual(d.seenNext.sort(), ["a", "b"]);
});

test("a missing notifications section is not treated as 'no CMEs'", () => {
  const d = decideCme(null, { cme_seen: [] }, T0);
  assert.equal(d.send, false);
  assert.match(d.reason, /no donki notifications available/);
});
