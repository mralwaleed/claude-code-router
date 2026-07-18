import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSwarmAttribution } from "../../packages/core/src/swarm/attribution.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import { RequestLogStore } from "../../packages/core/src/observability/request-log-store.ts";
import { UsageStore } from "../../packages/core/src/usage/store.ts";
import { createBetterSqliteDatabase } from "../../packages/core/src/storage/sqlite-native.ts";

const session = { id: "swrm_x", swarmId: "sw1", authTokenHash: "h", workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "claude-sid", startedAt: "t", lastSeenAt: "t", endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 };
const diagnostics = { classification: { kind: "agent", agentId: "worker", confidence: "exact", method: "exact-body-containment" }, candidateAgentIds: ["worker"], matchedLeaderAnchors: [], registryGeneration: 3 };
const routing = { owns: true, model: "glm-5.2", providerId: "prov-zai", reason: "swarm:agent-frontmatter" };

test("buildSwarmAttribution carries classification + selection, never secrets/body", () => {
  const a = buildSwarmAttribution({ requestId: "req-1", session, diagnostics, routing, now: "2026-01-01T00:00:00Z" });
  assert.equal(a.requestId, "req-1");
  assert.equal(a.swarmId, "sw1");
  assert.equal(a.swarmSessionId, "swrm_x");
  assert.equal(a.claudeSessionId, "claude-sid");
  assert.equal(a.classification, "exact");
  assert.equal(a.agentId, "worker");
  assert.equal(a.selectedModel, "glm-5.2");
  assert.equal(a.selectedProviderId, "prov-zai");
  assert.equal(a.routingReason, "swarm:agent-frontmatter");
  assert.equal(a.registryGeneration, 3);
  assert.equal(a.fallbackReason, "");
  // never carries raw token / body
  assert.equal(JSON.stringify(a).includes("authTokenHash"), false);
  assert.equal(JSON.stringify(a).includes("canonicalBody"), false);
});

test("SwarmStore persists + reads attribution", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-attr-"));
  const store = new SwarmStore(path.join(dir, "swarms.sqlite"));
  const a = buildSwarmAttribution({ requestId: "req-2", session, diagnostics, routing, now: "t" });
  await store.recordAttribution(a);
  const list = await store.listAttributionsBySession("swrm_x");
  assert.equal(list.length, 1);
  assert.equal(list[0].agentId, "worker");
  assert.equal(list[0].classification, "exact");
});

test("request_logs: additive swarm columns migrate idempotently + populate + fail-open", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-rl-"));
  const file = path.join(dir, "request-logs.sqlite");
  const store = new RequestLogStore(file);
  // annotateSwarm triggers schema open; missing row -> no-op, no throw (fail-open)
  await store.annotateSwarm("missing", { swarmId: "sw1", swarmSessionId: "swrm_x", agentId: "worker", classification: "exact", routingReason: "swarm:agent-frontmatter" });
  await store.annotateSwarm("missing", { swarmId: "sw1", swarmSessionId: "swrm_x", agentId: "worker", classification: "exact", routingReason: "r" }); // idempotent
  const read = createBetterSqliteDatabase(file);
  const cols = new Set(read.prepare("PRAGMA table_info(request_logs)").all().map((r) => r.name));
  for (const c of ["swarm_id", "swarm_session_id", "swarm_agent_id", "swarm_classification", "swarm_routing_reason"]) {
    assert.ok(cols.has(c), `missing column ${c}`);
  }
  // populate: insert a row then annotate
  read.exec("INSERT INTO request_logs (request_id, created_at, method, path) VALUES ('rid','t','POST','/v1/messages')");
  await store.annotateSwarm("rid", { swarmId: "sw1", swarmSessionId: "swrm_x", agentId: "worker", classification: "exact", routingReason: "swarm:agent-frontmatter" });
  const row = read.prepare("SELECT swarm_id, swarm_classification, swarm_routing_reason FROM request_logs WHERE request_id = 'rid'").get();
  assert.equal(row.swarm_id, "sw1");
  assert.equal(row.swarm_classification, "exact");
  assert.equal(row.swarm_routing_reason, "swarm:agent-frontmatter");
});

test("usage_events: additive swarm columns migrate idempotently", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-usage-"));
  const usageFile = path.join(dir, "usage.sqlite");
  const reqFile = path.join(dir, "request-logs.sqlite");
  const usage = new UsageStore(usageFile, { requestLogDbFile: reqFile });
  await usage.record({ createdAt: new Date().toISOString(), method: "POST", path: "/v1/messages", model: "Provider/m" });
  const read = createBetterSqliteDatabase(usageFile);
  const cols = new Set(read.prepare("PRAGMA table_info(usage_events)").all().map((r) => r.name));
  for (const c of ["swarm_id", "swarm_session_id", "swarm_agent_id", "swarm_classification"]) {
    assert.ok(cols.has(c), `missing column ${c}`);
  }
});

test("annotateRequestLogSwarm(undefined) is a safe no-op", async () => {
  // importing the fail-open wrapper; undefined swarm => returns immediately
  const { annotateRequestLogSwarm } = await import("../../packages/core/src/observability/request-log-store.ts");
  await annotateRequestLogSwarm("rid", undefined); // must not throw
});
