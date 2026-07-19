import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import {
  buildSwarmLaunchRuntime,
  createSwarmSession,
  disposeSwarmLaunchRuntime,
  stopSwarmSession
} from "../../packages/core/src/swarm/launch.ts";
import { hashSwarmToken } from "../../packages/core/src/swarm/token.ts";

function newStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-launch-"));
  return new SwarmStore(path.join(dir, "swarms.sqlite"));
}

test("createSwarmSession mints a token, persists its hash, returns the raw token", async () => {
  const store = newStore();
  const created = await createSwarmSession(store, {
    swarmId: "sw1",
    workspace: "/tmp/ws",
    launchDirectory: "/tmp/ws"
  });
  assert.ok(created.rawToken.startsWith("ccr-swarm-v1-"));
  assert.equal(created.session.authTokenHash, hashSwarmToken(created.rawToken));
  const stored = await store.getSessionById(created.session.id);
  assert.equal(stored?.status, "active");
  assert.equal(stored?.swarmId, "sw1");
});

test("buildSwarmLaunchRuntime writes an isolated ephemeral config (no global settings, no model)", async () => {
  const store = newStore();
  const { rawToken, session } = await createSwarmSession(store, {
    swarmId: "sw1",
    workspace: "/tmp/ws",
    launchDirectory: "/tmp/ws"
  });
  const configDir = mkdtempSync(path.join(tmpdir(), "swarm-cfg-"));
  const gateway = "http://127.0.0.1:3456";

  const rt = buildSwarmLaunchRuntime({ session, rawToken, gatewayEndpoint: gateway, configDir });

  // env points at the gateway; no model asserted (CCR decides routing); no token in env
  assert.equal(rt.env.ANTHROPIC_BASE_URL, gateway);
  assert.equal(rt.env.CLAUDE_CONFIG_DIR, rt.tempConfigDir);
  assert.equal("ANTHROPIC_MODEL" in rt.env, false);
  assert.equal("ANTHROPIC_API_KEY" in rt.env, false);
  for (const value of Object.values(rt.env)) {
    assert.ok(!value.includes(rawToken), "env must not carry the raw token");
  }

  // temp dir is strictly under the provided configDir (isolated; global ~/.claude untouched)
  assert.ok(rt.tempConfigDir.startsWith(path.join(configDir, "swarm-runtime")));
  assert.ok(existsSync(rt.tokenFile));
  assert.ok(existsSync(rt.proxyScript));
  assert.ok(existsSync(rt.settingsFile));

  // the 0600 token file holds the raw token; the proxy script embeds none and reads it at runtime
  assert.equal(readFileSync(rt.tokenFile, "utf8"), rawToken);
  assert.equal(statSync(rt.tokenFile).mode & 0o777, 0o600);
  const proxySrc = readFileSync(rt.proxyScript, "utf8");
  assert.ok(!proxySrc.includes(rawToken), "proxy script must not embed the raw token");

  // settings.json is minimal — no apiKeyHelper (the proxy injects auth), no token
  const settings = JSON.parse(readFileSync(rt.settingsFile, "utf8"));
  assert.equal(settings.apiKeyHelper, undefined);
  assert.equal(JSON.stringify(settings).includes(rawToken), false, "settings.json must not embed the token");
});

test("stopSwarmSession revokes the session and deletes the ephemeral runtime dir", async () => {
  const store = newStore();
  const { rawToken, session } = await createSwarmSession(store, {
    swarmId: "sw1",
    workspace: "/tmp/ws",
    launchDirectory: "/tmp/ws"
  });
  const configDir = mkdtempSync(path.join(tmpdir(), "swarm-cfg2-"));
  const rt = buildSwarmLaunchRuntime({ session, rawToken, gatewayEndpoint: "http://127.0.0.1:3456", configDir });

  await stopSwarmSession(store, session.id, rt.tempConfigDir);

  assert.equal((await store.getSessionById(session.id))?.status, "stopped");
  assert.equal(existsSync(rt.tempConfigDir), false, "runtime dir (with the raw-token helper) must be deleted");
  void disposeSwarmLaunchRuntime;
});
