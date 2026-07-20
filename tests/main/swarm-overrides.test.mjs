import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmAgentRegistry } from "../../packages/core/src/swarm/registry.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import { SwarmManagement } from "../../packages/core/src/swarm/manage.ts";
import { classifyRequest, MIN_CANONICAL_BODY_LENGTH } from "../../packages/core/src/swarm/classification.ts";
import { resolveSwarmRouting } from "../../packages/core/src/swarm/routing.ts";
import { ClaudeCodeLeaderDetector } from "../../packages/core/src/swarm/leader-detector.ts";
import { canonicalizeText } from "../../packages/core/src/swarm/canonicalize.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";
import { SWARM_ROUTING_REASON } from "../../packages/core/src/swarm/contracts.ts";

const PROVIDERS = providerViewsFromConfig([
  { id: "prov-a", name: "Alpha", models: ["a-model"] },
  { id: "prov-b", name: "Beta", models: ["b-model"] }
]);
const BODY = "# Test Agent\n\n## Mission\nThis is a sufficiently long agent body for attribution testing with unique content.";

function agentDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-ovr-"));
  writeFileSync(path.join(dir, "agent.md"), `---\nname: test-agent\nproviderId: prov-a\nmodel: a-model\n---\n${BODY}`);
  return dir;
}

async function scanWithOverrides(dir, overrides) {
  const reg = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers: PROVIDERS, watch: false, agentOverrides: overrides });
  await reg.initialScan();
  return reg.getRegistrySnapshot();
}

// ---- Override precedence ----

test("UI override beats frontmatter (assignmentSource = override)", async () => {
  const dir = agentDir();
  const snap = await scanWithOverrides(dir, { "test-agent": { providerId: "prov-b", model: "b-model" } });
  const agent = snap.agents[0];
  assert.equal(agent.providerOverrideId, "prov-b");
  assert.equal(agent.modelOverride, "b-model");
  assert.equal(agent.assignmentSource, "override");
});

test("clearing override restores frontmatter values", async () => {
  const dir = agentDir();
  const withOvr = await scanWithOverrides(dir, { "test-agent": { providerId: "prov-b", model: "b-model" } });
  assert.equal(withOvr.agents[0].providerOverrideId, "prov-b");
  const withoutOvr = await scanWithOverrides(dir, {});
  assert.equal(withoutOvr.agents[0].providerOverrideId, "prov-a");
  assert.equal(withoutOvr.agents[0].assignmentSource, "frontmatter");
});

test("disabled agent (via override) is excluded from classification", async () => {
  const dir = agentDir();
  const snap = await scanWithOverrides(dir, { "test-agent": { enabled: false } });
  assert.equal(snap.agents[0].enabled, false);
  const det = new ClaudeCodeLeaderDetector();
  const result = classifyRequest({ system: BODY, registry: snap, leaderDetector: det });
  assert.notEqual(result.classification.kind, "agent");
});

test("re-enabling agent restores attribution", async () => {
  const dir = agentDir();
  const snapDisabled = await scanWithOverrides(dir, { "test-agent": { enabled: false } });
  assert.notEqual(classifyRequest({ system: BODY, registry: snapDisabled, leaderDetector: new ClaudeCodeLeaderDetector() }).classification.kind, "agent");
  const snapEnabled = await scanWithOverrides(dir, {});
  assert.equal(classifyRequest({ system: BODY, registry: snapEnabled, leaderDetector: new ClaudeCodeLeaderDetector() }).classification.kind, "agent");
});

test("override with invalid provider does not produce a valid assignment", async () => {
  const dir = agentDir();
  const snap = await scanWithOverrides(dir, { "test-agent": { providerId: "nope", model: "x" } });
  // The override is applied (providerId=nope), but routing resolves it as invalid
  assert.equal(snap.agents[0].providerOverrideId, "nope");
});

// ---- Management service override lifecycle ----

test("management setAgentOverride persists + applies", async () => {
  const storeDir = mkdtempSync(path.join(tmpdir(), "swarm-mgmt-ovr-"));
  const store = new SwarmStore(path.join(storeDir, "swarms.sqlite"));
  const mgmt = new SwarmManagement(store, storeDir, "http://127.0.0.1:3456", PROVIDERS, undefined, false);
  const dir = agentDir();
  const profile = await mgmt.createProfile({
    name: "T", description: "", enabled: true, workspaceRoots: ["/tmp"], launchDirectory: "/tmp",
    mainInstructionFile: "", agentDirectories: [dir], leaderProviderId: "prov-a", leaderModel: "a-model",
    defaultProviderId: "prov-b", defaultModel: "b-model", fallbackProviderId: "", fallbackModel: "",
    routingMode: "exact", fallbackPolicy: "existing-ccr", autoDetectWorkspace: false, watchFiles: true, agentOverrides: {}
  });
  await mgmt.setAgentOverride(profile.id, "test-agent", { providerId: "prov-b", model: "b-model" });
  const stored = await store.getProfile(profile.id);
  assert.equal(stored.agentOverrides["test-agent"].providerId, "prov-b");
  const agents = await mgmt.getRegistry(profile.id);
  assert.equal(agents[0].providerOverrideId, "prov-b");
  assert.equal(agents[0].assignmentSource, "override");
});

test("management clearAgentOverride restores frontmatter", async () => {
  const storeDir = mkdtempSync(path.join(tmpdir(), "swarm-mgmt-clr-"));
  const store = new SwarmStore(path.join(storeDir, "swarms.sqlite"));
  const mgmt = new SwarmManagement(store, storeDir, "http://127.0.0.1:3456", PROVIDERS, undefined, false);
  const dir = agentDir();
  const profile = await mgmt.createProfile({
    name: "T", description: "", enabled: true, workspaceRoots: ["/tmp"], launchDirectory: "/tmp",
    mainInstructionFile: "", agentDirectories: [dir], leaderProviderId: "prov-a", leaderModel: "a-model",
    defaultProviderId: "prov-b", defaultModel: "b-model", fallbackProviderId: "", fallbackModel: "",
    routingMode: "exact", fallbackPolicy: "existing-ccr", autoDetectWorkspace: false, watchFiles: true, agentOverrides: {}
  });
  await mgmt.setAgentOverride(profile.id, "test-agent", { providerId: "prov-b", model: "b-model" });
  await mgmt.clearAgentOverride(profile.id, "test-agent");
  const stored = await store.getProfile(profile.id);
  assert.equal(stored.agentOverrides["test-agent"], undefined);
  const agents = await mgmt.getRegistry(profile.id);
  assert.equal(agents[0].providerOverrideId, "prov-a");
});

// ---- Fallback policies ----

function makeProfile(policy) {
  return {
    id: "sw1", schemaVersion: 1, name: "Sw", description: "", enabled: true,
    workspaceRoots: ["/tmp"], launchDirectory: "/tmp", mainInstructionFile: "", agentDirectories: [],
    leaderProviderId: "prov-a", leaderModel: "a-model",
    defaultProviderId: "prov-b", defaultModel: "b-model",
    fallbackProviderId: "", fallbackModel: "",
    routingMode: "exact", fallbackPolicy: policy, autoDetectWorkspace: false, watchFiles: true,
    agentOverrides: {}, createdAt: "", updatedAt: ""
  };
}

function diagAgent(agentId) {
  return { classification: { kind: "agent", agentId, confidence: "exact", method: "exact-body-containment" }, candidateAgentIds: [agentId], matchedLeaderAnchors: [], registryGeneration: 1 };
}

test("fallback existing-ccr: invalid agent + valid default → uses default", () => {
  const agents = [{ id: "a", swarmId: "sw1", slug: "a", displayName: "a", sourceFile: "/x", providerOverrideId: "nope", modelOverride: "x", enabled: true, capabilities: [], bodyHash: "h", distinctiveHash: "h", canonicalBody: "body", assignmentSource: "frontmatter", validationStatus: "ok", validationErrors: [], lastLoadedAt: "", lastModifiedAt: "" }];
  const r = resolveSwarmRouting({ diagnostics: diagAgent("a"), profile: makeProfile("existing-ccr"), agents, providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, "b-model"); // fell to default
});

test("fallback existing-ccr: invalid agent + invalid default → decline to CCR", () => {
  const agents = [{ id: "a", swarmId: "sw1", slug: "a", displayName: "a", sourceFile: "/x", providerOverrideId: "nope", modelOverride: "x", enabled: true, capabilities: [], bodyHash: "h", distinctiveHash: "h", canonicalBody: "body", assignmentSource: "frontmatter", validationStatus: "ok", validationErrors: [], lastLoadedAt: "", lastModifiedAt: "" }];
  const p = makeProfile("existing-ccr"); p.defaultProviderId = "nope"; p.defaultModel = "x";
  const r = resolveSwarmRouting({ diagnostics: diagAgent("a"), profile: p, agents, providers: PROVIDERS });
  assert.equal(r.owns, false);
  assert.equal(r.reason, SWARM_ROUTING_REASON.assignmentInvalid);
});

test("fallback swarm-default-required: invalid agent + valid default → uses default", () => {
  const agents = [{ id: "a", swarmId: "sw1", slug: "a", displayName: "a", sourceFile: "/x", providerOverrideId: "nope", modelOverride: "x", enabled: true, capabilities: [], bodyHash: "h", distinctiveHash: "h", canonicalBody: "body", assignmentSource: "frontmatter", validationStatus: "ok", validationErrors: [], lastLoadedAt: "", lastModifiedAt: "" }];
  const r = resolveSwarmRouting({ diagnostics: diagAgent("a"), profile: makeProfile("swarm-default-required"), agents, providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, "b-model");
});

test("fallback swarm-default-required: invalid agent + invalid default → REJECT (no CCR)", () => {
  const agents = [{ id: "a", swarmId: "sw1", slug: "a", displayName: "a", sourceFile: "/x", providerOverrideId: "nope", modelOverride: "x", enabled: true, capabilities: [], bodyHash: "h", distinctiveHash: "h", canonicalBody: "body", assignmentSource: "frontmatter", validationStatus: "ok", validationErrors: [], lastLoadedAt: "", lastModifiedAt: "" }];
  const p = makeProfile("swarm-default-required"); p.defaultProviderId = "nope"; p.defaultModel = "x";
  const r = resolveSwarmRouting({ diagnostics: diagAgent("a"), profile: p, agents, providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, undefined); // REJECT, not CCR
});

test("fallback fail-closed: invalid agent → REJECT (no default try, no CCR)", () => {
  const agents = [{ id: "a", swarmId: "sw1", slug: "a", displayName: "a", sourceFile: "/x", providerOverrideId: "nope", modelOverride: "x", enabled: true, capabilities: [], bodyHash: "h", distinctiveHash: "h", canonicalBody: "body", assignmentSource: "frontmatter", validationStatus: "ok", validationErrors: [], lastLoadedAt: "", lastModifiedAt: "" }];
  const r = resolveSwarmRouting({ diagnostics: diagAgent("a"), profile: makeProfile("fail-closed"), agents, providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, undefined);
  assert.equal(r.reason, SWARM_ROUTING_REASON.assignmentInvalid);
});

test("fallback all policies: unknown with valid default → uses default", () => {
  for (const policy of ["existing-ccr", "swarm-default-required", "fail-closed"]) {
    const r = resolveSwarmRouting({ diagnostics: { classification: { kind: "unknown" }, candidateAgentIds: [], matchedLeaderAnchors: [], registryGeneration: 1 }, profile: makeProfile(policy), agents: [], providers: PROVIDERS });
    assert.equal(r.owns, true, `${policy} unknown should use default`);
    assert.equal(r.model, "b-model", `${policy} unknown model`);
  }
});

test("fallback existing-ccr: unknown with invalid default → decline to CCR", () => {
  const p = makeProfile("existing-ccr"); p.defaultProviderId = "nope"; p.defaultModel = "x";
  const r = resolveSwarmRouting({ diagnostics: { classification: { kind: "unknown" }, candidateAgentIds: [], matchedLeaderAnchors: [], registryGeneration: 1 }, profile: p, agents: [], providers: PROVIDERS });
  assert.equal(r.owns, false);
});

test("fallback fail-closed: unknown with invalid default → REJECT", () => {
  const p = makeProfile("fail-closed"); p.defaultProviderId = "nope"; p.defaultModel = "x";
  const r = resolveSwarmRouting({ diagnostics: { classification: { kind: "unknown" }, candidateAgentIds: [], matchedLeaderAnchors: [], registryGeneration: 1 }, profile: p, agents: [], providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, undefined);
});

// ---- Session routing activity count ----

test("session activity count: zero attributions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-cnt0-"));
  const store = new SwarmStore(path.join(dir, "swarms.sqlite"));
  await store.upsertSession({ id: "s1", swarmId: "sw1", authTokenHash: "x".repeat(64), workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "", startedAt: "t", lastSeenAt: "t", endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 });
  assert.equal(await store.countAttributionsBySession("s1"), 0);
});

test("session activity count: multiple attributions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-cntN-"));
  const store = new SwarmStore(path.join(dir, "swarms.sqlite"));
  await store.upsertSession({ id: "s1", swarmId: "sw1", authTokenHash: "x".repeat(64), workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "", startedAt: "t", lastSeenAt: "t", endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 });
  for (let i = 0; i < 5; i++) {
    await store.recordAttribution({
      requestId: `r${i}`, swarmId: "sw1", swarmSessionId: "s1", claudeSessionId: "", classification: "exact",
      agentId: "a", candidateAgentIds: [], attributionMethod: "exact-body-containment", attributionConfidence: "exact",
      detectorVersion: "", matchedLeaderAnchors: [], registryGeneration: 1, routingReason: "swarm:agent-frontmatter",
      selectedProviderId: "prov-a", selectedModel: "a-model", fallbackReason: "", createdAt: "t"
    });
  }
  assert.equal(await store.countAttributionsBySession("s1"), 5);
});

test("backward compat: profile without fallbackPolicy/agentOverrides normalizes on read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-bc-"));
  const store = new SwarmStore(path.join(dir, "swarms.sqlite"));
  // insert a profile without the new fields (simulating an old DB)
  await store.upsertProfile({
    id: "old", schemaVersion: 1, name: "Old", description: "", enabled: true, workspaceRoots: ["/tmp"],
    launchDirectory: "/tmp", mainInstructionFile: "", agentDirectories: [],
    leaderProviderId: "prov-a", leaderModel: "a-model", defaultProviderId: "prov-b", defaultModel: "b-model",
    fallbackProviderId: "", fallbackModel: "", routingMode: "exact", autoDetectWorkspace: false, watchFiles: true,
    createdAt: "t", updatedAt: "t"
  });
  const read = await store.getProfile("old");
  assert.equal(read.fallbackPolicy, "existing-ccr");
  assert.deepEqual(read.agentOverrides, {});
});
