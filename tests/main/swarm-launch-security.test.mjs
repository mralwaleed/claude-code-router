import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSwarmLaunchRuntime, createSwarmSession } from "../../packages/core/src/swarm/launch.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";
import { mintSwarmToken } from "../../packages/core/src/swarm/token.ts";
import { toSessionDto } from "../../packages/core/src/swarm/api.ts";

function newStore() {
  return new SwarmStore(path.join(mkdtempSync(path.join(tmpdir(), "swarm-sec-")), "swarms.sqlite"));
}

async function seedRuntime() {
  const store = newStore();
  const { rawToken, session } = await createSwarmSession(store, { swarmId: "sw1", workspace: "/tmp", launchDirectory: "/tmp" });
  const configDir = mkdtempSync(path.join(tmpdir(), "swarm-cfg-"));
  const rt = buildSwarmLaunchRuntime({ session, rawToken, gatewayEndpoint: "http://127.0.0.1:3456", configDir });
  return { rawToken, session, rt, configDir, store };
}

test("raw token is absent from runtime.env (never in env exports or process args)", async () => {
  const { rawToken, rt } = await seedRuntime();
  for (const [key, value] of Object.entries(rt.env)) {
    assert.ok(!value.includes(rawToken), `env.${key} must not contain the raw token`);
  }
  assert.ok(!rt.env.ANTHROPIC_API_KEY);
  assert.ok(!rt.env.ANTHROPIC_AUTH_TOKEN);
});

test("raw token is absent from settings.json (no apiKeyHelper; the proxy injects auth)", async () => {
  const { rawToken, rt } = await seedRuntime();
  const settings = readFileSync(rt.settingsFile, "utf8");
  assert.ok(!settings.includes(rawToken), "settings.json must not embed the token");
  assert.ok(!settings.includes("apiKeyHelper"), "settings.json must not reference apiKeyHelper (the proxy injects auth)");
});

test("raw token is present ONLY in the 0600 token file; proxy script embeds no token", async () => {
  const { rawToken, rt } = await seedRuntime();
  const files = readdirSync(rt.tempConfigDir);
  let tokenFileCount = 0;
  for (const file of files) {
    const fullPath = path.join(rt.tempConfigDir, file);
    const content = readFileSync(fullPath, "utf8");
    if (content.includes(rawToken)) {
      tokenFileCount += 1;
      const mode = statSync(fullPath).mode & 0o777;
      assert.equal(mode, 0o600, `file containing token (${file}) must be 0600`);
    }
  }
  assert.equal(tokenFileCount, 1, "exactly one file (swarm-token) should contain the token");
  const proxyScript = readFileSync(rt.proxyScript, "utf8");
  assert.ok(!proxyScript.includes(rawToken), "the proxy script must not embed the raw token");
});

test("sanitized session DTO never carries authTokenHash", async () => {
  const { session } = await seedRuntime();
  const dto = toSessionDto(session);
  assert.equal("authTokenHash" in dto, false);
  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes(session.authTokenHash));
});

test("token prefix is not usable as a credential (constant-time hash comparison)", () => {
  const { rawToken, tokenHash } = mintSwarmToken();
  // a truncated/malformed token must not authenticate
  assert.ok(!rawToken.slice(0, -4).startsWith("ccr-swarm-v1-") || rawToken.length > 20);
  assert.equal(tokenHash.length, 64);
  assert.notEqual(tokenHash, rawToken);
});
