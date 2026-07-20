import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmAgentRegistry } from "../../packages/core/src/swarm/registry.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";

const PROVIDERS = providerViewsFromConfig([
  { id: "prov-alpha", name: "AlphaProvider", models: ["alpha-model"] }
]);

function newDir() {
  return mkdtempSync(path.join(tmpdir(), "swarm-life-"));
}

test("SwarmAgentRegistry initialScan builds a snapshot", async () => {
  const dir = newDir();
  writeFileSync(path.join(dir, "a.md"), "---\nname: agent-a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A\nbody a");
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  const snap = await registry.initialScan();
  assert.equal(snap.agents.length, 1);
  assert.equal(snap.agents[0].slug, "agent-a");
  assert.equal(snap.bySlug.get("agent-a")?.slug, "agent-a");
  assert.equal(snap.generation, 1);
  await registry.dispose();
});

test("snapshot is immutable (frozen arrays)", async () => {
  const dir = newDir();
  writeFileSync(path.join(dir, "a.md"), "---\nname: a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A");
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  const snap = await registry.initialScan();
  assert.equal(Object.isFrozen(snap.agents), true);
  assert.equal(Object.isFrozen(snap.diagnostics), true);
  assert.throws(() => snap.agents.push(snap.agents[0]), TypeError);
  await registry.dispose();
});

test("reloadAgent updates a single file without full rescan (generation increments)", async () => {
  const dir = newDir();
  const file = path.join(dir, "a.md");
  writeFileSync(file, "---\nname: a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A\nv1");
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  await registry.initialScan();
  const beforeBody = registry.getRegistrySnapshot().agents[0].bodyHash;
  writeFileSync(file, "---\nname: a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A\nv2 changed body");
  const snap = await registry.reloadAgent(file);
  assert.equal(snap.generation, 2);
  assert.notEqual(snap.agents[0].bodyHash, beforeBody);
  await registry.dispose();
});

test("removeAgent removes a file's entry", async () => {
  const dir = newDir();
  const file = path.join(dir, "a.md");
  writeFileSync(file, "---\nname: a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A");
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  await registry.initialScan();
  assert.equal(registry.getRegistrySnapshot().agents.length, 1);
  const snap = await registry.removeAgent(file);
  assert.equal(snap.agents.length, 0);
  await registry.dispose();
});

test("retain-last-valid: a file that becomes invalid keeps its prior entry marked degraded", async () => {
  const dir = newDir();
  const file = path.join(dir, "a.md");
  writeFileSync(file, "---\nname: a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A\nvalid body");
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  const initial = await registry.initialScan();
  const validHash = initial.agents[0].bodyHash;
  // break the file
  writeFileSync(file, "---\nname: a\n  :: broken yaml ::\n---\n# A");
  const snap = await registry.reloadAgent(file);
  const agent = snap.agents[0];
  assert.equal(agent.validationStatus, "degraded");
  assert.equal(agent.bodyHash, validHash); // retained last valid fingerprint
  assert.match(agent.validationErrors.join(" "), /retained last valid/);
  await registry.dispose();
});

test("recover: fixing the file returns the agent to ok", async () => {
  const dir = newDir();
  const file = path.join(dir, "a.md");
  writeFileSync(file, "---\nname: a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A\nv1");
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  await registry.initialScan();
  writeFileSync(file, "---\nname: a\n  :: broken ::\n---\n# A");
  await registry.reloadAgent(file);
  assert.equal(registry.getRegistrySnapshot().agents[0].validationStatus, "degraded");
  writeFileSync(file, "---\nname: a\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# A\nfixed");
  const snap = await registry.reloadAgent(file);
  assert.equal(snap.agents[0].validationStatus, "ok");
  await registry.dispose();
});

test("getWatcherStatus reports stopped when watch is disabled", async () => {
  const dir = newDir();
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  await registry.initialScan();
  assert.equal(registry.getWatcherStatus(), "stopped");
  await registry.dispose();
});
