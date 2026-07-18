import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import { createSwarmSession } from "../../packages/core/src/swarm/launch.ts";
import {
  SwarmAuth,
  computeSessionStatus,
  extractClaudeSessionId,
  recoverSessionsOnBoot,
  SWARM_SESSION_DEFAULT_MAX_LIFETIME_MS
} from "../../packages/core/src/swarm/session.ts";
import { hashSwarmToken } from "../../packages/core/src/swarm/token.ts";

function newStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-auth-"));
  return new SwarmStore(path.join(dir, "swarms.sqlite"));
}

async function seed(store, overrides = {}) {
  const created = await createSwarmSession(store, {
    swarmId: "sw1",
    workspace: "/tmp/ws",
    launchDirectory: "/tmp/ws",
    ttlMs: 60_000,
    ...overrides
  });
  return created;
}

test("authenticate succeeds for a valid active session", async () => {
  const store = newStore();
  const { rawToken, session } = await seed(store);
  const auth = new SwarmAuth(store, { now: () => Date.parse(session.startedAt) + 1000 });
  const outcome = await auth.authenticate(rawToken);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.session.id, session.id);
});

test("authenticate fail-closes on an unknown token (never global routing)", async () => {
  const store = newStore();
  await seed(store);
  const auth = new SwarmAuth(store);
  const outcome = await auth.authenticate("ccr-swarm-v1-unknownbase64token");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "invalid");
});

test("authenticate fail-closes on a non-swarm token", async () => {
  const store = newStore();
  const auth = new SwarmAuth(store);
  const outcome = await auth.authenticate("sk-ccr-something");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "invalid");
});

test("authenticate fail-closes on idle-expired session", async () => {
  const store = newStore();
  const { rawToken, session } = await seed(store, { ttlMs: 1000 });
  const auth = new SwarmAuth(store, { now: () => Date.parse(session.startedAt) + 60_000 });
  const outcome = await auth.authenticate(rawToken);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "expired");
  // persisted as expired
  const stored = await store.getSessionById(session.id);
  assert.equal(stored?.status, "expired");
});

test("absolute max-lifetime expires a session regardless of activity (clock-jump guard)", async () => {
  const store = newStore();
  const { rawToken, session } = await seed(store);
  // started 8 days ago, lastSeen recent (idle ok) but age > 7d max-lifetime
  const started = Date.now() - (SWARM_SESSION_DEFAULT_MAX_LIFETIME_MS + 86_400_000);
  await store.upsertSession({ ...session, startedAt: new Date(started).toISOString(), lastSeenAt: new Date(Date.now() - 1000).toISOString() });
  const auth = new SwarmAuth(store, { now: () => Date.now() });
  const outcome = await auth.authenticate(rawToken);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "expired");
});

test("authenticate fail-closes on a stopped session", async () => {
  const store = newStore();
  const { rawToken, session } = await seed(store);
  await store.updateSessionStatus(session.id, "stopped", new Date().toISOString());
  const auth = new SwarmAuth(store);
  const outcome = await auth.authenticate(rawToken);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "stopped");
});

test("reattach: first post-restart request marks the session reattached", async () => {
  const store = newStore();
  const { rawToken, session } = await seed(store);
  // boot time is after the session's last activity
  const auth = new SwarmAuth(store, { bootMs: Date.parse(session.lastSeenAt) + 10_000, now: () => Date.parse(session.lastSeenAt) + 10_001 });
  const outcome = await auth.authenticate(rawToken);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.session.status, "reattached");
  const stored = await store.getSessionById(session.id);
  assert.equal(stored?.status, "reattached");
});

test("PID is never an auth factor (stale PID reuse cannot grant access)", async () => {
  const store = newStore();
  const { rawToken, session } = await seed(store, { processId: 99999 });
  const auth = new SwarmAuth(store, { now: () => Date.parse(session.startedAt) + 1000 });
  const ok = await auth.authenticate(rawToken);
  assert.equal(ok.ok, true);
  // even if a different process reuses the PID, only the token hash authenticates
  await store.upsertSession({ ...session, processId: 99999 });
  const ok2 = await auth.authenticate(rawToken);
  assert.equal(ok2.ok, true);
});

test("concurrent swarms authenticate independently with no cross-match", async () => {
  const store = newStore();
  const a = await createSwarmSession(store, { swarmId: "swA", workspace: "/a", launchDirectory: "/a" });
  const b = await createSwarmSession(store, { swarmId: "swB", workspace: "/b", launchDirectory: "/b" });
  const auth = new SwarmAuth(store);
  const oa = await auth.authenticate(a.rawToken);
  const ob = await auth.authenticate(b.rawToken);
  assert.equal(oa.ok && oa.session.swarmId, "swA");
  assert.equal(ob.ok && ob.session.swarmId, "swB");
  // a's token does not authenticate as b
  assert.notEqual(a.rawToken, b.rawToken);
  assert.notEqual(hashSwarmToken(a.rawToken), hashSwarmToken(b.rawToken));
});

test("binding binds the Claude session id exactly once and rejects rebind", async () => {
  const store = newStore();
  const { session } = await seed(store);
  const auth = new SwarmAuth(store);
  assert.equal((await auth.bindClaudeSession(session.id, "sid-A")).ok, true);
  assert.equal((await auth.bindClaudeSession(session.id, "sid-A")).ok, true); // same id ok
  const mismatch = await auth.bindClaudeSession(session.id, "sid-B");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "binding-mismatch");
});

test("extractClaudeSessionId reads header then metadata.user_id", () => {
  assert.equal(extractClaudeSessionId(undefined, { "x-claude-code-session-id": "hdr-sid" }), "hdr-sid");
  assert.equal(extractClaudeSessionId({ metadata: { user_id: "acct_session_meta-sid" } }, {}), "meta-sid");
  assert.equal(extractClaudeSessionId({ metadata: {} }, {}), undefined);
});

test("recoverSessionsOnBoot expires sessions whose TTL elapsed while down", async () => {
  const store = newStore();
  const { session } = await seed(store, { ttlMs: 1000 });
  const future = Date.parse(session.startedAt) + 60_000;
  const n = await recoverSessionsOnBoot(store, future);
  assert.equal(n, 1);
  const stored = await store.getSessionById(session.id);
  assert.equal(stored?.status, "expired");
});

test("raw token is never persisted in the database (only its hash)", async () => {
  const store = newStore();
  const { rawToken, session } = await seed(store);
  assert.equal(session.authTokenHash, hashSwarmToken(rawToken));
  assert.notEqual(session.authTokenHash, rawToken);
});

test("raw token is absent from the on-disk db file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-persist-"));
  const file = path.join(dir, "swarms.sqlite");
  const store = new SwarmStore(file);
  const { rawToken } = await seed(store);
  await store.upsertSession((await store.listSessions())[0]); // flush
  const blob = readFileSync(file).toString("latin1");
  assert.ok(!blob.includes(rawToken), "raw token must not appear in the sqlite file");
});

test("computeSessionStatus: stopped/invalid are terminal", () => {
  const base = { startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), ttlMs: 60_000 };
  assert.equal(computeSessionStatus({ ...base, status: "stopped" }, Date.now()), "stopped");
  assert.equal(computeSessionStatus({ ...base, status: "invalid" }, Date.now()), "invalid");
});
