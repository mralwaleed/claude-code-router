/**
 * Commit-2 regression: the gateway refreshes effective registry assignments.
 *
 * Bug #2/A: the gateway passes profile.agentOverrides into the registry it builds.
 * Bug #3/C: a valid override repairs an agent's effective validation status.
 * Bug #4/B/D: a profile updatedAt change invalidates + rebuilds the cached registry;
 *            an unchanged updatedAt reuses the cache.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GatewayService, swarmRegistryNeedsRebuild } from "../../packages/core/src/gateway/service.ts";
import { SwarmAgentRegistry } from "../../packages/core/src/swarm/registry.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";

const PROVIDERS = [
  { id: "prov-a", name: "Provider A", models: ["model-a"] },
  { id: "prov-b", name: "Provider B", models: ["model-b"] }
];

function writeInvalidAgent(dir, slug = "bad") {
  writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\nname: ${slug}\ndescription: x\nmodel: ghost-model\n---\n# ${slug}\n\nA distinctive agent body long enough to fingerprint reliably for exact-body-containment attribution.`
  );
}

test("#3 + C a valid override repairs an agent with invalid frontmatter (status ok)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-v3a-"));
  try {
    writeInvalidAgent(dir);
    const reg = new SwarmAgentRegistry({
      swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false,
      agentOverrides: { bad: { providerId: "prov-a", model: "model-a" } }
    });
    await reg.initialScan();
    const agent = reg.getRegistrySnapshot().agents.find((a) => a.slug === "bad");
    assert.equal(agent.assignmentSource, "override");
    assert.equal(agent.validationStatus, "ok", "valid override must repair validation status");
    assert.equal(agent.providerOverrideId, "prov-a");
    await reg.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3 without an override the invalid-frontmatter agent stays invalid", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-v3b-"));
  try {
    writeInvalidAgent(dir);
    const reg = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false });
    await reg.initialScan();
    assert.equal(reg.getRegistrySnapshot().agents.find((a) => a.slug === "bad").validationStatus, "invalid");
    await reg.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2 + A gateway passes profile.agentOverrides into the registry it builds", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-gw2-"));
  try {
    writeInvalidAgent(dir);
    const store = new SwarmStore(path.join(mkdtempSync(path.join(tmpdir(), "swarm-gw2s-")), "swarms.sqlite"));
    const updatedAt = new Date().toISOString();
    await store.upsertProfile({
      id: "sw1", schemaVersion: 1, name: "P", description: "", enabled: true,
      workspaceRoots: ["/tmp"], launchDirectory: "/tmp", mainInstructionFile: "", agentDirectories: [dir],
      leaderProviderId: "prov-a", leaderModel: "model-a", defaultProviderId: "prov-a", defaultModel: "model-a",
      fallbackProviderId: "", fallbackModel: "", routingMode: "exact", fallbackPolicy: "existing-ccr",
      autoDetectWorkspace: false, watchFiles: false,
      agentOverrides: { bad: { providerId: "prov-b", model: "model-b" } }, createdAt: updatedAt, updatedAt
    });
    const session = { id: "swrm_a", swarmId: "sw1", authTokenHash: "h".repeat(64), workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "", startedAt: updatedAt, lastSeenAt: updatedAt, endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 };
    const gw = new GatewayService();
    gw.configureSwarmForTest({ Providers: PROVIDERS }, store);
    try {
      const ctx = await gw.swarmRequestContextForTest(session);
      assert.ok(ctx, "context resolved");
      const agent = ctx.registry.agents.find((a) => a.slug === "bad");
      assert.equal(agent.providerOverrideId, "prov-b", "gateway-applied override (#2/A)");
      assert.equal(agent.assignmentSource, "override");
    } finally {
      await gw.disposeSwarmRegistriesForTest();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#4 + B + D updatedAt change rebuilds the cache; unchanged updatedAt reuses it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-gw4-"));
  try {
    writeInvalidAgent(dir);
    const store = new SwarmStore(path.join(mkdtempSync(path.join(tmpdir(), "swarm-gw4s-")), "swarms.sqlite"));
    const now = () => new Date().toISOString();
    let updatedAt = now();
    const baseProfile = {
      id: "sw1", schemaVersion: 1, name: "P", description: "", enabled: true,
      workspaceRoots: ["/tmp"], launchDirectory: "/tmp", mainInstructionFile: "", agentDirectories: [dir],
      leaderProviderId: "prov-a", leaderModel: "model-a", defaultProviderId: "prov-a", defaultModel: "model-a",
      fallbackProviderId: "", fallbackModel: "", routingMode: "exact", fallbackPolicy: "existing-ccr",
      autoDetectWorkspace: false, watchFiles: false,
      agentOverrides: { bad: { providerId: "prov-a", model: "model-a" } }, createdAt: updatedAt, updatedAt
    };
    await store.upsertProfile(baseProfile);
    const session = { id: "swrm_b", swarmId: "sw1", authTokenHash: "h".repeat(64), workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "", startedAt: updatedAt, lastSeenAt: updatedAt, endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 };
    const gw = new GatewayService();
    gw.configureSwarmForTest({ Providers: PROVIDERS }, store);
    try {
      const ctx1 = await gw.swarmRequestContextForTest(session);
      assert.ok(ctx1);
      assert.equal(ctx1.registry.agents.find((a) => a.slug === "bad").providerOverrideId, "prov-a");
      updatedAt = now();
      await store.upsertProfile({ ...baseProfile, agentOverrides: { bad: { providerId: "prov-b", model: "model-b" } }, updatedAt });
      const ctx2 = await gw.swarmRequestContextForTest(session);
      assert.notEqual(ctx2.registry, ctx1.registry, "a profile change must rebuild the registry (B)");
      assert.equal(ctx2.registry.agents.find((a) => a.slug === "bad").providerOverrideId, "prov-b", "rebuilt registry reflects the new override (B)");
      const ctx3 = await gw.swarmRequestContextForTest(session);
      assert.equal(ctx3.registry, ctx2.registry, "unchanged updatedAt reuses the cached registry (D)");
    } finally {
      await gw.disposeSwarmRegistriesForTest();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#4 swarmRegistryNeedsRebuild predicate", () => {
  assert.equal(swarmRegistryNeedsRebuild(undefined, "t1"), true);
  assert.equal(swarmRegistryNeedsRebuild("t1", "t1"), false);
  assert.equal(swarmRegistryNeedsRebuild("t1", "t2"), true);
});
