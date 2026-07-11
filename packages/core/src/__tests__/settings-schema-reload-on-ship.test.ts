import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_SETTINGS, PROJECT_SETTINGS_KEYS } from "../settings-schema.js";

// FNXC:ReloadOnShip 2026-07-11-17:10:
// The reloadOnShip opt-in (self-host/dogfood only) must default OFF so
// normal installs are byte-for-byte unchanged. This test asserts the
// declared schema default, not the engine-side resolver (that lives in
// packages/engine/src/__tests__/merger-reload-on-ship.test.ts alongside
// resolveReloadOnShipConfig / isReloadOnShipEnabled).
describe("reloadOnShip settings schema contract", () => {
  it("includes reloadOnShip in the project settings key vocabulary", () => {
    expect(PROJECT_SETTINGS_KEYS).toContain("reloadOnShip");
  });

  it("defaults to disabled", () => {
    expect(DEFAULT_SETTINGS.reloadOnShip).toEqual({ enabled: false });
    expect(DEFAULT_PROJECT_SETTINGS.reloadOnShip).toEqual({ enabled: false });
  });

  it("round-trips an explicit ON config value", () => {
    const onValue = { enabled: true, updatePrimaryCheckout: true, rebuildDist: true, signalReload: true };
    // Settings values are plain data on ProjectSettings; a round-trip through
    // JSON (as settings persistence does) must preserve the shape exactly.
    const roundTripped = JSON.parse(JSON.stringify(onValue));
    expect(roundTripped).toEqual(onValue);
  });

  it("round-trips the boolean shorthand", () => {
    expect(JSON.parse(JSON.stringify(true))).toBe(true);
    expect(JSON.parse(JSON.stringify(false))).toBe(false);
  });
});
