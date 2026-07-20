import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBetterSqliteDatabase } from "../../packages/core/src/storage/sqlite-native.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";

function newDbFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-store-"));
  return path.join(dir, "swarms.sqlite");
}

function sampleProfile(id = "sw1") {
  return {
    id,
    schemaVersion: 1,
    name: "Sample",
    description: "",
    enabled: true,
    workspaceRoots: ["/tmp/ws"],
    launchDirectory: "/tmp/ws",
    mainInstructionFile: "",
    agentDirectories: ["/tmp/ws/agents"],
    leaderProviderId: "prov-a",
    leaderModel: "fable",
    defaultProviderId: "prov-b",
    defaultModel: "glm",
    fallbackProviderId: "",
    fallbackModel: "",
    routingMode: "exact",
    autoDetectWorkspace: false,
    watchFiles: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

test("SwarmStore creates schema and round-trips a profile", async () => {
  const file = newDbFile();
  const store = new SwarmStore(file);
  await store.upsertProfile(sampleProfile());
  const list = await store.listProfiles();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "sw1");
  assert.equal(list[0].leaderModel, "fable");
  const got = await store.getProfile("sw1");
  assert.equal(got?.name, "Sample");
  assert.equal(await store.getProfile("missing"), undefined);
});

test("SwarmStore records schema_version = 1 in swarm_meta", async () => {
  const file = newDbFile();
  const store = new SwarmStore(file);
  await store.upsertProfile(sampleProfile());
  const db = createBetterSqliteDatabase(file);
  const row = db.prepare("SELECT value_json FROM swarm_meta WHERE key = 'schema_version'").get();
  assert.equal(JSON.parse(row.value_json), 1);
});

test("SwarmStore re-open is idempotent (migration does not throw)", async () => {
  const file = newDbFile();
  const a = new SwarmStore(file);
  await a.upsertProfile(sampleProfile());
  const b = new SwarmStore(file); // re-open -> ensureSwarmSchema runs again
  const list = await b.listProfiles();
  assert.equal(list.length, 1);
});

test("SwarmStore deletes a profile and its agents", async () => {
  const file = newDbFile();
  const store = new SwarmStore(file);
  await store.upsertProfile(sampleProfile());
  await store.replaceAgents("sw1", []);
  assert.equal(await store.deleteProfile("sw1"), true);
  assert.deepEqual(await store.listProfiles(), []);
});

test("SwarmStore preserves unknown/forward-compat fields via the doc column", async () => {
  const file = newDbFile();
  const store = new SwarmStore(file);
  // Attach a field that does not exist in the v1 SwarmProfile type (simulates a newer schema).
  const extended = { ...sampleProfile(), futureField: { whatever: 42 } };
  await store.upsertProfile(extended);
  const got = await store.getProfile("sw1");
  assert.equal(got?.futureField?.whatever, 42);
});

test("SwarmStore replaces the agent set for a swarm", async () => {
  const file = newDbFile();
  const store = new SwarmStore(file);
  await store.upsertProfile(sampleProfile());
  const agent = (slug, hash) => ({
    id: `sw1-${slug}`,
    swarmId: "sw1",
    slug,
    displayName: slug,
    sourceFile: `/tmp/${slug}.md`,
    providerOverrideId: "prov-a",
    modelOverride: "m",
    enabled: true,
    capabilities: [],
    bodyHash: hash,
    distinctiveHash: hash,
    assignmentSource: "frontmatter",
    validationStatus: "ok",
    validationErrors: [],
    lastLoadedAt: "t",
    lastModifiedAt: "t"
  });
  await store.replaceAgents("sw1", [agent("a", "h1"), agent("b", "h2")]);
  let agents = await store.listAgents("sw1");
  assert.equal(agents.length, 2);
  await store.replaceAgents("sw1", [agent("c", "h3")]);
  agents = await store.listAgents("sw1");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].slug, "c");
});

test("SwarmStore upserts, resolves, touches, and ends sessions", async () => {
  const file = newDbFile();
  const store = new SwarmStore(file);
  const session = {
    id: "sess-1",
    swarmId: "sw1",
    authTokenHash: "deadbeef".repeat(8),
    workspace: "/tmp/ws",
    launchDirectory: "/tmp/ws",
    processId: 123,
    claudeSessionId: "",
    startedAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    endedAt: "",
    status: "active",
    launcherType: "cli",
    ttlMs: 43200000
  };
  await store.upsertSession(session);
  const byHash = await store.getSessionByTokenHash(session.authTokenHash);
  assert.equal(byHash?.id, "sess-1");
  const active = await store.listActiveSessions();
  assert.equal(active.length, 1);
  await store.touchSession("sess-1", "2026-01-01T00:05:00Z");
  assert.equal((await store.getSessionById("sess-1"))?.lastSeenAt, "2026-01-01T00:05:00Z");
  await store.updateSessionStatus("sess-1", "ended", "2026-01-01T00:10:00Z");
  assert.equal((await store.getSessionById("sess-1"))?.status, "ended");
  assert.equal((await store.listActiveSessions()).length, 0);
});

test("SwarmStore records and lists attributions", async () => {
  const file = newDbFile();
  const store = new SwarmStore(file);
  await store.recordAttribution({
    requestId: "req-1",
    swarmSessionId: "sess-1",
    swarmId: "sw1",
    claudeSessionId: "",
    classification: "exact",
    agentId: "sw1-a",
    candidateAgentIds: [],
    attributionMethod: "exact-body-containment",
    attributionConfidence: "exact",
    detectorVersion: "",
    matchedLeaderAnchors: [],
    registryGeneration: 1,
    routingReason: "swarm:agent-frontmatter",
    selectedProviderId: "prov-a",
    selectedModel: "a-model",
    fallbackReason: "",
    createdAt: "2026-01-01T00:00:00Z"
  });
  const list = await store.listAttributionsBySession("sess-1");
  assert.equal(list.length, 1);
  assert.equal(list[0].agentId, "sw1-a");
});

test("SwarmStore fails OPEN when the DB cannot be opened (no throw, degraded, empty reads)", async () => {
  // parent path is a regular file -> mkdirSync inside open() throws -> degraded
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-fail-"));
  const blocker = path.join(dir, "i-am-a-file");
  writeFileSync(blocker, "x");
  const file = path.join(blocker, "swarms.sqlite");
  const store = new SwarmStore(file);
  const profiles = await store.listProfiles();
  const got = await store.getProfile("x");
  const ok = await store.upsertProfile(sampleProfile());
  assert.deepEqual(profiles, []);
  assert.equal(got, undefined);
  assert.equal(ok, undefined);
  assert.equal(store.status, "degraded");
  assert.ok(store.degradeReason.length > 0);
});

test("SwarmStore fails OPEN when the DB file is corrupt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-corrupt-"));
  const file = path.join(dir, "swarms.sqlite");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "this is not sqlite");
  const store = new SwarmStore(file);
  // operations must not throw
  const profiles = await store.listProfiles();
  assert.deepEqual(profiles, []);
  assert.equal(store.status, "degraded");
});
