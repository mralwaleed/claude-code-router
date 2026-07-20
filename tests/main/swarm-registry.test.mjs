import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_MAX_FILE_SIZE,
  applyDuplicateDetection,
  isAcceptableAgentFile,
  scanAgentDirectories,
  scanAgentDirectory
} from "../../packages/core/src/swarm/agent-registry.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";

const PROVIDERS = providerViewsFromConfig([
  { id: "prov-alpha", name: "AlphaProvider", models: ["alpha-model", "shared"] },
  { id: "prov-beta", name: "BetaProvider", models: ["beta-model"] }
]);

function agentDir() {
  return mkdtempSync(path.join(tmpdir(), "swarm-reg-"));
}
function writeAgent(dir, file, body) {
  writeFileSync(path.join(dir, file), body);
}

test("isAcceptableAgentFile: md only; rejects hidden/swap/backup/temp", () => {
  assert.equal(isAcceptableAgentFile("worker.md"), true);
  assert.equal(isAcceptableAgentFile(".worker.md"), false);
  assert.equal(isAcceptableAgentFile("worker.md~"), false);
  assert.equal(isAcceptableAgentFile("worker.md.swp"), false);
  assert.equal(isAcceptableAgentFile("worker.md.bak"), false);
  assert.equal(isAcceptableAgentFile("worker.txt"), false);
  assert.equal(isAcceptableAgentFile("#worker.md#"), false);
});

test("scanAgentDirectory scans md only, deterministic order", () => {
  const dir = agentDir();
  writeAgent(dir, "zeta.md", "---\nname: zeta\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# Zeta\nbody z");
  writeAgent(dir, "alpha.md", "---\nname: alpha\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# Alpha\nbody a");
  writeAgent(dir, "alpha.md.bak", "---\nname: ignored\n---\nshould be ignored");
  writeAgent(dir, ".hidden.md", "---\nname: ignored\n---\nshould be ignored");
  const { agents, diagnostics } = scanAgentDirectory(dir, "sw1", PROVIDERS);
  assert.equal(diagnostics.accessible, true);
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((a) => a.slug), ["alpha", "zeta"]); // sorted by slug
  assert.equal(agents[0].bodyHash.length, 64);
  assert.notEqual(agents[0].bodyHash, agents[1].bodyHash);
});

test("scanAgentDirectory flags duplicate slug", () => {
  const dir = agentDir();
  writeAgent(dir, "a.md", "---\nname: dup\n---\n# A unique body");
  writeAgent(dir, "b.md", "---\nname: dup\n---\n# B different body");
  const { agents } = scanAgentDirectory(dir, "sw1", PROVIDERS);
  const dups = agents.filter((a) => a.slug === "dup");
  assert.equal(dups.length, 2);
  for (const a of dups) {
    assert.equal(a.validationStatus, "invalid");
    assert.match(a.validationErrors.join(" "), /duplicate slug/);
  }
});

test("scanAgentDirectory flags identical canonical bodies (collision)", () => {
  const dir = agentDir();
  const body = "---\nname: one\n---\n# Same\nIdentical body line.";
  writeAgent(dir, "one.md", body);
  writeAgent(dir, "two.md", body.replace("name: one", "name: two"));
  const { agents } = scanAgentDirectory(dir, "sw1", PROVIDERS);
  const colliding = agents.filter((a) => a.validationStatus === "collides");
  assert.equal(colliding.length, 2);
});

test("scanAgentDirectory marks model-without-provider invalid", () => {
  const dir = agentDir();
  writeAgent(dir, "lonely.md", "---\nname: lonely\nmodel: alpha-model\n---\n# Lonely");
  const { agents } = scanAgentDirectory(dir, "sw1", PROVIDERS);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].validationStatus, "invalid");
  assert.match(agents[0].validationErrors.join(" "), /no resolvable provider/);
});

test("scanAgentDirectory resolves providerId over display provider", () => {
  const dir = agentDir();
  writeAgent(dir, "w.md", "---\nname: w\nprovider: AlphaProvider\nproviderId: prov-alpha\nmodel: alpha-model\n---\n# W");
  const { agents } = scanAgentDirectory(dir, "sw1", PROVIDERS);
  assert.equal(agents[0].validationStatus, "ok");
  assert.equal(agents[0].providerOverrideId, "prov-alpha");
});

test("scanAgentDirectory retains a degraded entry for an unreadable/oversize file", () => {
  const dir = agentDir();
  writeAgent(dir, "big.md", "# " + "x".repeat(AGENT_MAX_FILE_SIZE + 1));
  const { agents } = scanAgentDirectory(dir, "sw1", PROVIDERS);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].validationStatus, "invalid");
  assert.equal(agents[0].enabled, false); // blocked
  assert.match(agents[0].validationErrors.join(" "), /exceeds|unreadable/);
});

test("scanAgentDirectory reports a missing directory without crashing", () => {
  const { agents, diagnostics } = scanAgentDirectory("/nonexistent/swarm-dir-xyz", "sw1", PROVIDERS);
  assert.deepEqual(agents, []);
  assert.equal(diagnostics.accessible, false);
  assert.ok(diagnostics.warning);
});

test("scanAgentDirectories flags duplicate source file across configured dirs", () => {
  const dir = agentDir();
  writeAgent(dir, "solo.md", "---\nname: solo\nmodel: alpha-model\nproviderId: prov-alpha\n---\n# Solo body");
  // same physical directory referenced twice
  const result = scanAgentDirectories([dir, dir], "sw1", PROVIDERS);
  const dups = result.agents.filter((a) => a.validationErrors.some((e) => /duplicate source file/.test(e)));
  assert.ok(dups.length >= 1);
});

test("applyDuplicateDetection is deterministic (idempotent)", () => {
  const dir = agentDir();
  writeAgent(dir, "p.md", "---\nname: p\n---\n# P body");
  writeAgent(dir, "q.md", "---\nname: p\n---\n# Q body"); // dup slug
  const a = scanAgentDirectory(dir, "sw1", PROVIDERS).agents;
  const once = applyDuplicateDetection(a.map((x) => ({ ...x, validationErrors: [...x.validationErrors] })));
  const twice = applyDuplicateDetection(once.map((x) => ({ ...x, validationErrors: [...x.validationErrors] })));
  assert.deepEqual(
    twice.map((x) => `${x.id}:${x.validationStatus}`).sort(),
    once.map((x) => `${x.id}:${x.validationStatus}`).sort()
  );
});
