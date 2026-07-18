import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { scanAgentDirectories } from "../../packages/core/src/swarm/agent-registry.ts";
import { SwarmAgentRegistry } from "../../packages/core/src/swarm/registry.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";

const PROVIDERS = providerViewsFromConfig([{ id: "prov", name: "Prov", models: ["m"] }]);
const N = 50;

function buildAgentDir(n) {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-perf-"));
  for (let i = 0; i < n; i += 1) {
    writeFileSync(
      path.join(dir, `agent-${String(i).padStart(3, "0")}.md`),
      `---
name: agent-${i}
model: m
providerId: prov
---
# Agent ${i}

Unique body number ${i}. Implements a synthetic task with a distinctive description
so fingerprinting remains unambiguous across the registry population. Seed-${i}-${Math.random()}.
`
    );
  }
  return dir;
}

test("initial scan of 50 synthetic agents is fast and deterministic", () => {
  const dir = buildAgentDir(N);
  const t0 = performance.now();
  const { agents } = scanAgentDirectories([dir], "sw1", PROVIDERS);
  const elapsed = performance.now() - t0;

  assert.equal(agents.length, N);
  // all valid + unique bodies
  assert.equal(agents.every((a) => a.validationStatus === "ok"), true);
  const hashes = agents.map((a) => a.bodyHash);
  assert.equal(new Set(hashes).size, N);
  // generous budget (CI/electron overhead); proves no O(fs-walk-per-request pathology
  assert.ok(elapsed < 2000, `scan took ${elapsed.toFixed(1)}ms`);
});

test("registry lookup is in-memory (snapshot maps), not a filesystem scan", async () => {
  const dir = buildAgentDir(N);
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
  await registry.initialScan();
  const snap = registry.getRegistrySnapshot();

  const t0 = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    snap.bySlug.get(`agent-${i % N}`);
  }
  const elapsed = performance.now() - t0;
  // 1000 in-memory map lookups must be effectively free vs a filesystem scan
  assert.ok(elapsed < 50, `1000 lookups took ${elapsed.toFixed(2)}ms`);
  assert.equal(snap.bySlug.size, N);
  await registry.dispose();
});
