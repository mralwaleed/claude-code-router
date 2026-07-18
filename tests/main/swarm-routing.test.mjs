import assert from "node:assert/strict";
import test from "node:test";
import { resolveSwarmRouting } from "../../packages/core/src/swarm/routing.ts";
import { SWARM_ROUTING_REASON } from "../../packages/core/src/swarm/contracts.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";

const PROVIDERS = providerViewsFromConfig([
  { id: "prov-a", name: "Alpha", models: ["a-model"] },
  { id: "prov-b", name: "Beta", models: ["b-model"] }
]);

function diag(kind, agentId) {
  const base = { candidateAgentIds: agentId ? [agentId] : [], matchedLeaderAnchors: [], registryGeneration: 1 };
  if (kind === "agent") return { ...base, classification: { kind: "agent", agentId, confidence: "exact", method: "exact-body-containment" } };
  if (kind === "leader") return { ...base, classification: { kind: "leader", detectorVersion: "ccr-leader-v1" } };
  if (kind === "unknown") return { ...base, classification: { kind: "unknown" } };
  return { ...base, classification: { kind: "ambiguous", candidateAgentIds: ["a", "b"] } };
}

function swarmAgent(id, opts = {}) {
  return {
    id, swarmId: "sw1", slug: id, displayName: id, sourceFile: `/tmp/${id}.md`,
    providerOverrideId: opts.providerId ?? "", modelOverride: opts.model ?? "",
    enabled: true, capabilities: [], bodyHash: "h", distinctiveHash: "h", canonicalBody: "body",
    assignmentSource: opts.source ?? "frontmatter",
    validationStatus: "ok", validationErrors: [], lastLoadedAt: "", lastModifiedAt: ""
  };
}

function profile(overrides = {}) {
  return {
    id: "sw1", schemaVersion: 1, name: "Sw", description: "", enabled: true,
    workspaceRoots: ["/tmp"], launchDirectory: "/tmp", mainInstructionFile: "", agentDirectories: ["/tmp/agents"],
    leaderProviderId: "prov-a", leaderModel: "a-model",
    defaultProviderId: "prov-b", defaultModel: "b-model",
    fallbackProviderId: "", fallbackModel: "",
    routingMode: "exact", fallbackPolicy: "existing-ccr", autoDetectWorkspace: false, watchFiles: true, agentOverrides: {}, createdAt: "", updatedAt: "",
    ...overrides
  };
}

test("agent UI override beats frontmatter (reason swarm:agent-ui-override)", () => {
  const agents = [swarmAgent("w", { providerId: "prov-a", model: "a-model", source: "override" })];
  const r = resolveSwarmRouting({ diagnostics: diag("agent", "w"), profile: profile(), agents, providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.reason, SWARM_ROUTING_REASON.agentUiOverride);
});

test("agent frontmatter assignment (reason swarm:agent-frontmatter)", () => {
  const agents = [swarmAgent("w", { providerId: "prov-a", model: "a-model", source: "frontmatter" })];
  const r = resolveSwarmRouting({ diagnostics: diag("agent", "w"), profile: profile(), agents, providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.reason, SWARM_ROUTING_REASON.agentFrontmatter);
});

test("leader assignment (reason swarm:leader)", () => {
  const r = resolveSwarmRouting({ diagnostics: diag("leader"), profile: profile(), agents: [], providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, "a-model");
  assert.equal(r.reason, SWARM_ROUTING_REASON.leader);
});

test("unknown uses default (reason swarm:default-unknown)", () => {
  const r = resolveSwarmRouting({ diagnostics: diag("unknown"), profile: profile(), agents: [], providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, "b-model");
  assert.equal(r.reason, SWARM_ROUTING_REASON.defaultUnknown);
});

test("ambiguous uses default (reason swarm:default-ambiguous)", () => {
  const r = resolveSwarmRouting({ diagnostics: diag("ambiguous"), profile: profile(), agents: [], providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.reason, SWARM_ROUTING_REASON.defaultAmbiguous);
});

test("invalid agent provider => decline (swarm:assignment-invalid)", () => {
  const agents = [swarmAgent("w", { providerId: "nope", model: "a-model" })];
  const r = resolveSwarmRouting({ diagnostics: diag("agent", "w"), profile: profile(), agents, providers: PROVIDERS });
  assert.equal(r.owns, false);
  assert.equal(r.reason, SWARM_ROUTING_REASON.assignmentInvalid);
});

test("invalid model (not under provider) => decline", () => {
  const agents = [swarmAgent("w", { providerId: "prov-a", model: "b-model" })];
  const r = resolveSwarmRouting({ diagnostics: diag("agent", "w"), profile: profile(), agents, providers: PROVIDERS });
  assert.equal(r.owns, false);
  assert.equal(r.reason, SWARM_ROUTING_REASON.assignmentInvalid);
});

test("missing default with no fallback => decline", () => {
  const p = profile({ defaultProviderId: "", defaultModel: "", fallbackProviderId: "", fallbackModel: "" });
  const r = resolveSwarmRouting({ diagnostics: diag("unknown"), profile: p, agents: [], providers: PROVIDERS });
  assert.equal(r.owns, false);
  assert.equal(r.reason, SWARM_ROUTING_REASON.assignmentInvalid);
});

test("unknown cascades to fallback when default invalid", () => {
  const p = profile({ defaultProviderId: "missing", defaultModel: "x", fallbackProviderId: "prov-a", fallbackModel: "a-model" });
  const r = resolveSwarmRouting({ diagnostics: diag("unknown"), profile: p, agents: [], providers: PROVIDERS });
  assert.equal(r.owns, true);
  assert.equal(r.model, "a-model");
  assert.equal(r.reason, SWARM_ROUTING_REASON.defaultUnknown);
});

test("agent id not present in registry => decline", () => {
  const r = resolveSwarmRouting({ diagnostics: diag("agent", "ghost"), profile: profile(), agents: [], providers: PROVIDERS });
  assert.equal(r.owns, false);
  assert.equal(r.reason, SWARM_ROUTING_REASON.assignmentInvalid);
});
