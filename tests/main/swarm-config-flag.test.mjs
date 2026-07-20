import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "../../packages/core/src/config/default-config.ts";
import { parseSwarmForTest } from "../../packages/core/src/config/config.ts";

test("feature flag defaults to disabled", () => {
  const config = createDefaultAppConfig({ generatedConfigFile: "/tmp/ccr-gateway.config.json" });
  assert.equal(config.swarm?.enabled, false);
});

test("parseSwarm accepts a real boolean", () => {
  assert.deepEqual(parseSwarmForTest({ enabled: true }), { enabled: true });
  assert.deepEqual(parseSwarmForTest({ enabled: false }), { enabled: false });
});

test("parseSwarm rejects non-boolean enabled (no partial/truthy coercion)", () => {
  // mirrors parseObservability's strict boolean check; prevents a corrupt config from enabling swarm
  assert.equal(parseSwarmForTest({ enabled: 1 }), undefined);
  assert.equal(parseSwarmForTest({ enabled: "true" }), undefined);
  assert.equal(parseSwarmForTest(undefined), undefined);
  assert.equal(parseSwarmForTest("nope"), undefined);
  assert.equal(parseSwarmForTest({}), undefined);
});

test("parseSwarm ignores unknown sibling keys", () => {
  assert.deepEqual(parseSwarmForTest({ enabled: true, unknownKey: "x" }), { enabled: true });
});
