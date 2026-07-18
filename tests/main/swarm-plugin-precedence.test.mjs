import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeCodeRouterPlugin } from "../../packages/core/src/gateway/claude-code-router-plugin.ts";
import { SwarmAgentRegistry } from "../../packages/core/src/swarm/registry.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";
import { SWARM_ROUTING_REASON } from "../../packages/core/src/swarm/contracts.ts";

// Build a plugin + a real registry snapshot over a temp dir of synthetic agents.
function setup(agents) {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-plugin-"));
  for (const a of agents) {
    writeFileSync(
      path.join(dir, a.file),
      `---\nname: ${a.name}\nproviderId: Provider\nmodel: ${a.model}\n---\n${a.body}`
    );
  }
  const config = {
    CUSTOM_ROUTER_PATH: "",
    Providers: [{ name: "Provider", models: ["claude-sonnet", "gpt-5-codex"], type: "anthropic_messages" }],
    Router: { builtInRules: { "claude-code": { enabled: true }, codex: { enabled: true } }, fallback: { mode: "off", models: [], retryCount: 1 }, rules: [] },
    profile: { enabled: true, profiles: [{ agent: "claude-code", enabled: true, id: "cc", model: "Provider/claude-sonnet", name: "Claude Code", scope: "global" }] }
  };
  const plugin = new ClaudeCodeRouterPlugin(config);
  const providers = providerViewsFromConfig(config.Providers);
  const registry = new SwarmAgentRegistry({ swarmId: "sw1", agentDirectories: [dir], providers, watch: false });
  return { dir, plugin, providers, registry, config };
}

const WORKER_BODY = "# Worker\n\n## Mission\nImplement one task with the smallest safe change and verify each increment.";
const profile = (overrides = {}) => ({
  id: "sw1", schemaVersion: 1, name: "Sw", description: "", enabled: true,
  workspaceRoots: ["/tmp"], launchDirectory: "/tmp", mainInstructionFile: "", agentDirectories: [],
  leaderProviderId: "Provider", leaderModel: "claude-sonnet",
  defaultProviderId: "Provider", defaultModel: "gpt-5-codex",
  fallbackProviderId: "", fallbackModel: "", routingMode: "exact", autoDetectWorkspace: false, watchFiles: true,
  createdAt: "", updatedAt: "", ...overrides
});
const session = { id: "swrm_x", swarmId: "sw1", authTokenHash: "h", workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "", startedAt: "t", lastSeenAt: "t", endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 };

test("swarm agent match owns routing (swarm:agent-frontmatter)", async () => {
  const { plugin, providers, registry } = setup([{ file: "worker.md", name: "worker", model: "claude-sonnet", body: WORKER_BODY }]);
  await registry.initialScan();
  const res = await plugin.routeRequest({
    body: { model: "Provider/claude-sonnet", system: [{ type: "text", text: WORKER_BODY }], messages: [] },
    headers: { "user-agent": "claude-code/2.1" }, method: "POST", url: "/v1/messages",
    swarm: { session, profile: profile(), registry: registry.getRegistrySnapshot(), providers }
  });
  assert.equal(res.decision.reason, SWARM_ROUTING_REASON.agentFrontmatter);
  assert.equal(res.swarm.diagnostics.classification.kind, "agent");
});

test("swarm unknown uses default (swarm:default-unknown)", async () => {
  const { plugin, providers, registry } = setup([]);
  await registry.initialScan();
  const res = await plugin.routeRequest({
    body: { model: "Provider/claude-sonnet", system: "an ad-hoc task that matches no agent", messages: [] },
    headers: { "user-agent": "claude-code/2.1" }, method: "POST", url: "/v1/messages",
    swarm: { session, profile: profile(), registry: registry.getRegistrySnapshot(), providers }
  });
  assert.equal(res.decision.reason, SWARM_ROUTING_REASON.defaultUnknown);
  assert.equal(res.decision.model, "gpt-5-codex");
});

test("swarm decline (invalid default) falls through to existing CCR (marker compatibility)", async () => {
  const { plugin, providers, registry, dir } = setup([]);
  await registry.initialScan();
  // profile with an invalid default -> swarm declines -> existing CCR (profile) handles it
  const res = await plugin.routeRequest({
    body: { model: "claude-default", system: "ad-hoc unknown task", messages: [] },
    headers: { "user-agent": "claude-code/2.1" }, method: "POST", url: "/v1/messages",
    swarm: { session, profile: profile({ defaultProviderId: "nope", defaultModel: "x", leaderProviderId: "nope", leaderModel: "x" }), registry: registry.getRegistrySnapshot(), providers }
  });
  assert.equal(res.swarm.routing.owns, false);
  assert.equal(res.decision.reason, "builtin:claude-code");
});

test("marker cannot override a valid swarm assignment", async () => {
  const { plugin, providers, registry } = setup([{ file: "worker.md", name: "worker", model: "claude-sonnet", body: WORKER_BODY }]);
  await registry.initialScan();
  // body carries a legacy marker AND the worker body; swarm owns (agent match) -> marker ignored
  const res = await plugin.routeRequest({
    body: { model: "Provider/claude-sonnet", system: [{ type: "text", text: `<CCR-AGENT-MODEL>Provider/gpt-5-codex</CCR-AGENT-MODEL>\n${WORKER_BODY}` }], messages: [] },
    headers: { "user-agent": "claude-code/2.1" }, method: "POST", url: "/v1/messages",
    swarm: { session, profile: profile(), registry: registry.getRegistrySnapshot(), providers }
  });
  assert.equal(res.decision.reason, SWARM_ROUTING_REASON.agentFrontmatter);
  assert.equal(res.decision.model, "claude-sonnet");
});

test("non-swarm request is unchanged (no swarm context)", async () => {
  const { plugin } = setup([]);
  const res = await plugin.routeRequest({
    body: { model: "claude-default", system: "anything", messages: [] },
    headers: { "user-agent": "claude-code/2.1" }, method: "POST", url: "/v1/messages"
  });
  assert.equal(res.swarm, undefined);
  assert.equal(res.decision.reason, "builtin:claude-code");
});

test("feature flag off: no swarm field passed -> existing routing (caller omits context)", async () => {
  const { plugin } = setup([]);
  const res = await plugin.routeRequest({
    body: { model: "claude-default", system: "x", messages: [] },
    headers: { "user-agent": "claude-code/2.1" }, method: "POST", url: "/v1/messages" /* no swarm */
  });
  assert.equal(res.swarm, undefined);
});
