import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyDraft,
  resetModelOnProviderChange,
  validateSwarmDraft
} from "../../packages/ui/src/pages/home/shared/swarm-view-model.ts";

const PROVIDERS = [
  { id: "prov-a", name: "Alpha", models: ["a1", "a2"] },
  { id: "prov-b", name: "Beta", models: ["b1"] }
];

test("validateSwarmDraft: valid draft returns null", () => {
  const d = { ...emptyDraft(), name: "Test", leaderProviderId: "prov-a", leaderModel: "a1", defaultProviderId: "prov-b", defaultModel: "b1" };
  assert.equal(validateSwarmDraft(d), null);
});

test("validateSwarmDraft: missing name => error", () => {
  const d = { ...emptyDraft(), leaderProviderId: "prov-a", leaderModel: "a1", defaultProviderId: "prov-b", defaultModel: "b1" };
  assert.match(validateSwarmDraft(d) ?? "", /Name/);
});

test("validateSwarmDraft: missing leader => error", () => {
  const d = { ...emptyDraft(), name: "Test", defaultProviderId: "prov-b", defaultModel: "b1" };
  assert.match(validateSwarmDraft(d) ?? "", /Leader/);
});

test("validateSwarmDraft: missing default => error", () => {
  const d = { ...emptyDraft(), name: "Test", leaderProviderId: "prov-a", leaderModel: "a1" };
  assert.match(validateSwarmDraft(d) ?? "", /Default/);
});

test("resetModelOnProviderChange: changing provider resets incompatible model", () => {
  const d = { ...emptyDraft(), leaderProviderId: "prov-a", leaderModel: "a1" };
  const updated = resetModelOnProviderChange({ ...d, leaderProviderId: "prov-b" }, PROVIDERS, "leaderProviderId");
  assert.equal(updated.leaderModel, ""); // "a1" not under "prov-b" → cleared
});

test("resetModelOnProviderChange: keeping provider keeps model", () => {
  const d = { ...emptyDraft(), leaderProviderId: "prov-a", leaderModel: "a1" };
  const updated = resetModelOnProviderChange(d, PROVIDERS, "leaderProviderId");
  assert.equal(updated.leaderModel, "a1"); // still valid under "prov-a"
});

test("resetModelOnProviderChange: model valid under new provider is kept", () => {
  const d = { ...emptyDraft(), leaderProviderId: "prov-a", leaderModel: "a1" };
  const updated = resetModelOnProviderChange({ ...d, leaderProviderId: "prov-a" }, PROVIDERS, "leaderProviderId");
  assert.equal(updated.leaderModel, "a1");
});

test("emptyDraft returns enabled + watchFiles defaults", () => {
  const d = emptyDraft();
  assert.equal(d.enabled, true);
  assert.equal(d.watchFiles, true);
  assert.equal(d.autoDetectWorkspace, false);
  assert.equal(d.name, "");
});
