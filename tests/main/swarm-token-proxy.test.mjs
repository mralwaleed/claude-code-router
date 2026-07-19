/**
 * Commit-4 regression: the loopback token proxy + its security contract.
 *
 * The proxy reads the Swarm token from a 0600 file and injects x-api-key toward the local
 * gateway, so the raw token never enters Claude Code's env/argv, the proxy script, SQLite
 * (only the hash), or logs. OAuth `authorization` is forwarded unchanged. Rotation rewrites
 * the token file in place. A missing token file fails closed. Stopped-session / wrong tokens
 * are rejected. Cross-process stop removes the proxy + token file + runtime dir.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSwarmLaunchRuntime,
  createInProcessSwarmTokenProxy,
  createSwarmSession,
  killSwarmTokenProxy,
  stopSwarmSession
} from "../../packages/core/src/swarm/launch.ts";
import { SwarmAuth } from "../../packages/core/src/swarm/session.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import { mintSwarmToken } from "../../packages/core/src/swarm/token.ts";

async function withMockUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("#5 killSwarmTokenProxy reads the pidfile and signals the recorded pid", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-kill-"));
  try {
    const { spawn } = await import("node:child_process");
    const dummy = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" });
    const pidFile = path.join(dir, "proxy.pid");
    writeFileSync(pidFile, String(dummy.pid), { mode: 0o600 });
    killSwarmTokenProxy(pidFile);
    const exited = await new Promise((resolve) => dummy.on("exit", () => resolve(true)));
    assert.equal(exited, true, "killSwarmTokenProxy must SIGTERM the pid from the pidfile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy injects the Swarm token as x-api-key; OAuth authorization forwarded unchanged", async () => {
  const { rawToken } = mintSwarmToken();
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-px-inj-"));
  const tokenFile = path.join(dir, "swarm-token");
  writeFileSync(tokenFile, rawToken, { mode: 0o600 });
  let captured;
  const upstream = await withMockUpstream((req, res) => {
    captured = { "x-api-key": req.headers["x-api-key"], authorization: req.headers["authorization"] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = await createInProcessSwarmTokenProxy({ tokenFile, upstreamHost: "127.0.0.1", upstreamPort: upstream.port });
  try {
    assert.equal(proxy.server.address().address, "127.0.0.1", "proxy binds only to loopback");
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oauth-token", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(res.status, 200);
    assert.equal(captured["x-api-key"], rawToken, "Swarm token injected toward the local gateway only");
    assert.equal(captured.authorization, "Bearer oauth-token", "OAuth authorization forwarded unchanged");
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve));
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy rotation: rewriting the token file changes the injected token (no embedding)", async () => {
  const t1 = mintSwarmToken().rawToken;
  const t2 = mintSwarmToken().rawToken;
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-px-rot-"));
  const tokenFile = path.join(dir, "swarm-token");
  writeFileSync(tokenFile, t1, { mode: 0o600 });
  const seen = [];
  const upstream = await withMockUpstream((req, res) => { seen.push(req.headers["x-api-key"]); res.writeHead(200); res.end("{}"); });
  const proxy = await createInProcessSwarmTokenProxy({ tokenFile, upstreamHost: "127.0.0.1", upstreamPort: upstream.port });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    writeFileSync(tokenFile, t2, { mode: 0o600 });
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual(seen, [t1, t2], "rotation takes effect via file re-read (token never embedded in the proxy)");
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve));
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy with a missing token file injects no x-api-key (fail closed at the gateway)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-px-miss-"));
  const tokenFile = path.join(dir, "swarm-token-absent");
  let captured;
  const upstream = await withMockUpstream((req, res) => { captured = req.headers["x-api-key"]; res.writeHead(200); res.end("{}"); });
  const proxy = await createInProcessSwarmTokenProxy({ tokenFile, upstreamHost: "127.0.0.1", upstreamPort: upstream.port });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(captured, undefined, "no token injected when the token file is missing -> gateway rejects");
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve));
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security: raw token absent from Claude Code env (buildSwarmLaunchRuntime)", async () => {
  const store = new SwarmStore(path.join(mkdtempSync(path.join(tmpdir(), "swarm-env-")), "swarms.sqlite"));
  const { rawToken, session } = await createSwarmSession(store, { swarmId: "sw1", workspace: "/tmp", launchDirectory: "/tmp" });
  const configDir = mkdtempSync(path.join(tmpdir(), "swarm-envcfg-"));
  try {
    const rt = buildSwarmLaunchRuntime({ session, rawToken, gatewayEndpoint: "http://127.0.0.1:3456", configDir });
    for (const [key, value] of Object.entries(rt.env)) {
      assert.ok(!value.includes(rawToken), `env.${key} must not contain the raw token`);
    }
    assert.ok(!rt.env.ANTHROPIC_API_KEY, "no ANTHROPIC_API_KEY in env");
    assert.ok(!rt.env.ANTHROPIC_AUTH_TOKEN, "no ANTHROPIC_AUTH_TOKEN in env");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("security: raw token present ONLY in the 0600 token file; proxy script + argv carry no token", async () => {
  const store = new SwarmStore(path.join(mkdtempSync(path.join(tmpdir(), "swarm-art-")), "swarms.sqlite"));
  const { rawToken, session } = await createSwarmSession(store, { swarmId: "sw1", workspace: "/tmp", launchDirectory: "/tmp" });
  const configDir = mkdtempSync(path.join(tmpdir(), "swarm-artcfg-"));
  try {
    const rt = buildSwarmLaunchRuntime({ session, rawToken, gatewayEndpoint: "http://127.0.0.1:3456", configDir });
    const proxySrc = readFileSync(rt.proxyScript, "utf8");
    assert.ok(!proxySrc.includes(rawToken), "proxy script must not embed the raw token");
    assert.ok(proxySrc.includes("readFileSync") && proxySrc.includes("process.argv"), "proxy reads the token from the file path in argv (not the token itself)");
    assert.ok(proxySrc.includes("127.0.0.1"), "spawned proxy binds only to loopback");
    let tokenFiles = 0;
    for (const file of readdirSync(rt.tempConfigDir)) {
      const full = path.join(rt.tempConfigDir, file);
      if (readFileSync(full, "utf8").includes(rawToken)) {
        tokenFiles += 1;
        assert.equal(statSync(full).mode & 0o777, 0o600, `token file ${file} must be 0600`);
      }
    }
    assert.equal(tokenFiles, 1, "exactly one file (swarm-token) holds the raw token");
    assert.ok(!rt.tokenFile.includes(rawToken), "token file path must not contain the raw token");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("security: SQLite stores only the hash, never the raw token", async () => {
  const store = new SwarmStore(path.join(mkdtempSync(path.join(tmpdir(), "swarm-sql-")), "swarms.sqlite"));
  const { rawToken, session } = await createSwarmSession(store, { swarmId: "sw1", workspace: "/tmp", launchDirectory: "/tmp" });
  const stored = await store.getSessionById(session.id);
  assert.equal(stored.authTokenHash.length, 64, "hash is sha256");
  assert.ok(!stored.authTokenHash.includes(rawToken), "raw token never stored");
  assert.ok(!JSON.stringify(stored).includes(rawToken), "raw token absent from the whole session record");
});

test("security: SwarmAuth rejects a wrong token and a stopped-session token (fail closed)", async () => {
  const store = new SwarmStore(path.join(mkdtempSync(path.join(tmpdir(), "swarm-auth-")), "swarms.sqlite"));
  const auth = new SwarmAuth(store);
  const { rawToken, session } = await createSwarmSession(store, { swarmId: "sw1", workspace: "/tmp", launchDirectory: "/tmp" });
  assert.equal((await auth.authenticate(rawToken)).ok, true);
  const wrong = mintSwarmToken().rawToken;
  const wrongOutcome = await auth.authenticate(wrong);
  assert.equal(wrongOutcome.ok, false);
  assert.equal(wrongOutcome.reason, "invalid");
  await stopSwarmSession(store, session.id);
  const stoppedOutcome = await auth.authenticate(rawToken);
  assert.equal(stoppedOutcome.ok, false);
  assert.equal(stoppedOutcome.reason, "stopped");
});
