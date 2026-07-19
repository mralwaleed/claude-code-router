import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeLaunchAdapter } from "../../packages/core/src/swarm/launch-adapter.ts";
import { SwarmManagement } from "../../packages/core/src/swarm/manage.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";
import {
  sanitizeOverrideMap,
  validateAgentSlug,
  validateFallbackPolicy,
  validateOverridePayload,
  validateSwarmId
} from "../../packages/core/src/swarm/payload-validation.ts";
import { ClaudeCodeRouterPlugin } from "../../packages/core/src/gateway/claude-code-router-plugin.ts";
import { SwarmAgentRegistry } from "../../packages/core/src/swarm/registry.ts";
import { SWARM_ROUTING_REASON } from "../../packages/core/src/swarm/contracts.ts";

const PROVIDERS = providerViewsFromConfig([{ id: "prov-a", name: "Alpha", models: ["a-model"] }]);

// ---- Launch adapter (item 2) ----

async function newMgmt(adapter) {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-adapt-"));
  const store = new SwarmStore(path.join(dir, "swarms.sqlite"));
  const mgmt = new SwarmManagement(store, dir, "http://127.0.0.1:3456", PROVIDERS, undefined, false, adapter);
  const launchDir = path.join(dir, "launch");
  mkdirSync(launchDir, { recursive: true });
  const p = await mgmt.createProfile({
    name: "T", description: "", enabled: true, workspaceRoots: [launchDir], launchDirectory: launchDir,
    mainInstructionFile: "", agentDirectories: [], leaderProviderId: "prov-a", leaderModel: "a-model",
    defaultProviderId: "prov-a", defaultModel: "a-model", fallbackProviderId: "", fallbackModel: "",
    routingMode: "exact", fallbackPolicy: "existing-ccr", autoDetectWorkspace: false, watchFiles: true, agentOverrides: {}
  });
  return { dir, store, mgmt, profile: p, launchDir };
}

test("fake launch adapter: success creates ACTIVE session", async () => {
  const adapter = new FakeLaunchAdapter();
  const { mgmt, profile } = await newMgmt(adapter);
  const result = await mgmt.launch(profile.id);
  assert.equal(result.ok, true);
  assert.ok(result.session);
  assert.equal(adapter.calls.length, 1);
  // The adapter was called with the launch script path (not the token)
  assert.ok(!adapter.calls[0].launchScript.includes("ccr-swarm-v1-"));
});

test("fake launch adapter: failure creates no orphan session", async () => {
  const adapter = new FakeLaunchAdapter();
  adapter.shouldFail = true;
  const { mgmt, profile, store } = await newMgmt(adapter);
  const result = await mgmt.launch(profile.id);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Fake launch failure/);
  // No active session left
  const sessions = await store.listActiveSessions();
  assert.equal(sessions.length, 0);
});

test("launch adapter never receives raw token in arguments", async () => {
  const adapter = new FakeLaunchAdapter();
  const { mgmt, profile } = await newMgmt(adapter);
  await mgmt.launch(profile.id);
  for (const call of adapter.calls) {
    assert.ok(!call.launchScript.includes("ccr-swarm-v1-"), "launch script path must not contain token");
    assert.ok(!JSON.stringify(call).includes("ccr-swarm-v1-"), "no token in adapter input");
  }
});

// ---- Payload validation (item 3) ----

test("validateSwarmId rejects empty, oversized, null bytes, dangerous chars", () => {
  assert.equal(validateSwarmId(""), undefined);
  assert.equal(validateSwarmId(null), undefined);
  assert.equal(validateSwarmId("a".repeat(129)), undefined);
  assert.equal(validateSwarmId("id\0evil"), undefined);
  assert.equal(validateSwarmId("id;rm -rf"), undefined);
  assert.equal(validateSwarmId("valid_id-1"), "valid_id-1");
});

test("validateAgentSlug rejects dangerous chars", () => {
  assert.equal(validateAgentSlug("worker"), "worker");
  assert.equal(validateAgentSlug("__proto__"), undefined);
  assert.equal(validateAgentSlug("constructor"), undefined);
  assert.equal(validateAgentSlug("a/b"), undefined);
  assert.equal(validateAgentSlug(""), undefined);
});

test("validateFallbackPolicy rejects unsupported values", () => {
  assert.equal(validateFallbackPolicy("existing-ccr"), "existing-ccr");
  assert.equal(validateFallbackPolicy("invalid"), undefined);
  assert.equal(validateFallbackPolicy(null), undefined);
});

test("validateOverridePayload rejects unknown fields", () => {
  assert.ok(validateOverridePayload({ providerId: "p", model: "m" }));
  assert.equal(validateOverridePayload({ providerId: "p", evil: true }), undefined);
});

test("validateOverridePayload rejects non-boolean enabled", () => {
  assert.equal(validateOverridePayload({ enabled: "yes" }), undefined);
  assert.equal(validateOverridePayload({ enabled: 1 }), undefined);
  assert.ok(validateOverridePayload({ enabled: true }));
});

test("sanitizeOverrideMap rejects prototype-pollution keys", () => {
  const safe = sanitizeOverrideMap({
    worker: { providerId: "p", model: "m" },
    __proto__: { providerId: "evil" },
    constructor: { providerId: "evil" },
    prototype: { providerId: "evil" }
  });
  assert.deepEqual(Object.keys(safe), ["worker"]);
  assert.equal(safe.worker.providerId, "p");
  assert.equal(Object.getPrototypeOf(safe), null); // null-prototype map
});

test("sanitizeOverrideMap drops invalid slug keys", () => {
  const safe = sanitizeOverrideMap({
    "valid-slug": { providerId: "p" },
    "invalid/slug": { providerId: "p" },
    "": { providerId: "p" }
  });
  assert.deepEqual(Object.keys(safe), ["valid-slug"]);
});

// ---- Controlled rejection (item 6) ----

test("fail-closed with invalid agent → owns=true, model=undefined (gateway 503 condition)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-reject-"));
  const agentDir = path.join(dir, "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "w.md"), "---\nname: worker\nproviderId: nope\nmodel: bad\n---\n# Worker\nunique body for rejection test");
  const config = {
    CUSTOM_ROUTER_PATH: "",
    Providers: [{ name: "prov-a", models: ["a-model"], type: "anthropic_messages" }],
    Router: { builtInRules: { "claude-code": { enabled: true }, codex: { enabled: true } }, fallback: { mode: "off", models: [], retryCount: 1 }, rules: [] },
    profile: { enabled: true, profiles: [{ agent: "claude-code", enabled: true, id: "cc", model: "prov-a/a-model", name: "CC", scope: "global" }] }
  };
  const plugin = new ClaudeCodeRouterPlugin(config);
  const providers = providerViewsFromConfig(config.Providers);
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [agentDir], providers, watch: false });
  await registry.initialScan();
  const session = { id: "swrm_x", swarmId: "sw1", authTokenHash: "h", workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "", startedAt: "t", lastSeenAt: "t", endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 };
  const failClosedProfile = {
    id: "sw1", schemaVersion: 1, name: "FC", description: "", enabled: true, workspaceRoots: ["/tmp"], launchDirectory: "/tmp",
    mainInstructionFile: "", agentDirectories: [agentDir], leaderProviderId: "nope", leaderModel: "bad",
    defaultProviderId: "nope", defaultModel: "bad", fallbackProviderId: "", fallbackModel: "",
    routingMode: "exact", fallbackPolicy: "fail-closed", autoDetectWorkspace: false, watchFiles: true, agentOverrides: {}, createdAt: "", updatedAt: ""
  };
  const agentBody = "# Worker\nunique body for rejection test";
  const result = await plugin.routeRequest({
    body: { model: "prov-a/a-model", system: [{ type: "text", text: agentBody }], messages: [] },
    headers: { "user-agent": "claude-code/2.1" }, method: "POST", url: "/v1/messages",
    swarm: { session, profile: failClosedProfile, registry: registry.getRegistrySnapshot(), providers }
  });
  // Swarm owns but has no model → gateway returns 503 (provider never called)
  assert.equal(result.swarm.routing.owns, true);
  assert.equal(result.swarm.routing.model, undefined);
  assert.equal(result.decision.model, undefined);
  assert.equal(result.decision.reason, SWARM_ROUTING_REASON.assignmentInvalid);
});
