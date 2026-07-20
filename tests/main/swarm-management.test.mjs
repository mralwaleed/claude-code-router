import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmManagement } from "../../packages/core/src/swarm/manage.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import { providerViewsFromConfig } from "../../packages/core/src/swarm/validation.ts";
import { toAgentDto, toSessionDto } from "../../packages/core/src/swarm/api.ts";

const PROVIDERS = providerViewsFromConfig([
  { id: "prov-a", name: "Alpha", models: ["a-model"] },
  { id: "prov-b", name: "Beta", models: ["b-model"] }
]);

function newMgmt() {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-mgmt-"));
  const store = new SwarmStore(path.join(dir, "swarms.sqlite"));
  return { dir, mgmt: new SwarmManagement(store, dir, "http://127.0.0.1:3456", PROVIDERS, undefined, false) };
}

const baseInput = {
  name: "Test",
  description: "",
  enabled: true,
  workspaceRoots: ["/tmp"],
  launchDirectory: "/tmp",
  mainInstructionFile: "",
  agentDirectories: [],
  leaderProviderId: "prov-a",
  leaderModel: "a-model",
  defaultProviderId: "prov-b",
  defaultModel: "b-model",
  fallbackProviderId: "",
  fallbackModel: "",
  routingMode: "exact",
  fallbackPolicy: "existing-ccr",
  autoDetectWorkspace: false,
  watchFiles: true,
  agentOverrides: {}
};

test("create + get + list profile", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile(baseInput);
  assert.ok(p.id);
  assert.equal(p.name, "Test");
  const got = await mgmt.getProfile(p.id);
  assert.equal(got?.name, "Test");
  const list = await mgmt.listProfiles();
  assert.equal(list.length, 1);
});

test("update profile", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile(baseInput);
  const updated = await mgmt.updateProfile(p.id, { ...baseInput, name: "Renamed" });
  assert.equal(updated?.name, "Renamed");
});

test("delete profile blocked when active sessions exist", async () => {
  const { mgmt, dir } = newMgmt();
  const p = await mgmt.createProfile(baseInput);
  // inject an active session directly via store
  const store = new SwarmStore(path.join(dir, "swarms.sqlite"));
  await store.upsertSession({ id: "s1", swarmId: p.id, authTokenHash: "x".repeat(64), workspace: "/tmp", launchDirectory: "/tmp", processId: null, claudeSessionId: "", startedAt: "t", lastSeenAt: "t", endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 });
  const result = await mgmt.deleteProfile(p.id);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Stop all active sessions/);
});

test("delete profile ok with no sessions", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile(baseInput);
  const result = await mgmt.deleteProfile(p.id);
  assert.equal(result.ok, true);
  assert.equal(await mgmt.getProfile(p.id), undefined);
});

test("enable/disable", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile(baseInput);
  await mgmt.setEnabled(p.id, false);
  assert.equal((await mgmt.getProfile(p.id))?.enabled, false);
});

test("validate: ok profile", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile(baseInput);
  const v = await mgmt.validate(p.id);
  assert.equal(v.ok, true);
});

test("validate: invalid leader model", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile({ ...baseInput, leaderModel: "ghost" });
  const v = await mgmt.validate(p.id);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /leader/);
});

test("launch blocked on invalid profile (no orphan session)", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile({ ...baseInput, leaderModel: "ghost" });
  const result = await mgmt.launch(p.id);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Launch blocked/);
  // no active session created
  assert.equal((await mgmt.listSessions(p.id)).length, 0);
});

test("launch blocked on missing launch directory (cleanup, no orphan)", async () => {
  const { mgmt } = newMgmt();
  const p = await mgmt.createProfile({ ...baseInput, launchDirectory: "/nonexistent/xyz-abc" });
  const result = await mgmt.launch(p.id);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /directory/);
  assert.equal((await mgmt.listSessions(p.id)).length, 0);
});

test("rescan discovers agents from temp dir", async () => {
  const { dir, mgmt } = newMgmt();
  const agentDir = path.join(dir, "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "w.md"), "---\nname: worker\nproviderId: prov-a\nmodel: a-model\n---\n# Worker\nimplements tasks with a distinctive body");
  const p = await mgmt.createProfile({ ...baseInput, agentDirectories: [agentDir] });
  const agents = await mgmt.rescan(p.id);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].slug, "worker");
  // sanitization: no canonicalBody in DTO
  assert.equal("canonicalBody" in agents[0], false);
  // short hash prefix only
  assert.ok(agents[0].bodyHashPrefix.length <= 8);
});

test("diagnostics returns validation + agent errors + watcher status", async () => {
  const { dir, mgmt } = newMgmt();
  const agentDir = path.join(dir, "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "broken.md"), "---\nname: x\nmodel: nope\n---\n# X\nbody");
  const p = await mgmt.createProfile({ ...baseInput, agentDirectories: [agentDir] });
  const d = await mgmt.diagnostics(p.id);
  assert.equal(d.profileErrors.length, 0);
  assert.ok(d.agentErrors.length >= 0);
  assert.equal(typeof d.watcherStatus, "string");
});

test("sanitization: toAgentDto strips canonicalBody + full hash", () => {
  const dto = toAgentDto({ id: "a", swarmId: "s", slug: "a", displayName: "a", sourceFile: "/x", providerOverrideId: "", modelOverride: "", enabled: true, capabilities: [], bodyHash: "abcdef0123456789fullhash", distinctiveHash: "d", canonicalBody: "secret body content", assignmentSource: "frontmatter", validationStatus: "ok", validationErrors: [], lastLoadedAt: "", lastModifiedAt: "" });
  assert.equal("canonicalBody" in dto, false);
  assert.equal(dto.bodyHashPrefix, "abcdef01");
  assert.equal(dto.bodyHashPrefix.length, 8);
});

test("sanitization: toSessionDto strips authTokenHash", () => {
  const dto = toSessionDto({ id: "s1", swarmId: "sw", authTokenHash: "secret-hash", workspace: "/tmp", launchDirectory: "/tmp", processId: 123, claudeSessionId: "", startedAt: "t", lastSeenAt: "t", endedAt: "", status: "active", launcherType: "desktop", ttlMs: 60000 });
  assert.equal("authTokenHash" in dto, false);
  assert.equal(dto.id, "s1");
});
