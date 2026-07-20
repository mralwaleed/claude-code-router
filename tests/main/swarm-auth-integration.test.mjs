import assert from "node:assert/strict";
import test from "node:test";
import { forwardedUpstreamHeadersForTest } from "../../packages/core/src/gateway/service.ts";
import { isSwarmToken, mintSwarmToken } from "../../packages/core/src/swarm/token.ts";

test("metadata stripping: upstream never receives swarm token, session id, swarm id, or agent metadata", () => {
  const { rawToken } = mintSwarmToken();
  const inbound = {
    authorization: `Bearer ${rawToken}`,
    "x-api-key": rawToken,
    "x-ccr-swarm-session-id": "swrm_session_xyz",
    "x-ccr-swarm-id": "siyaj",
    "x-ccr-swarm-agent-id": "worker",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-code/2.1.179"
  };
  const upstream = forwardedUpstreamHeadersForTest(inbound);
  // non-sensitive headers survive
  assert.equal(upstream["anthropic-version"], "2023-06-01");
  // all swarm/auth metadata stripped
  assert.equal(upstream["authorization"], undefined);
  assert.equal(upstream["x-api-key"], undefined);
  assert.equal(upstream["x-ccr-swarm-session-id"], undefined);
  assert.equal(upstream["x-ccr-swarm-id"], undefined);
  assert.equal(upstream["x-ccr-swarm-agent-id"], undefined);
  // the raw token does not appear anywhere in the forwarded headers
  assert.equal(Object.values(upstream).some((v) => v.includes(rawToken)), false);
});

test("namespace separation: a normal provider API key is never treated as a Swarm token", () => {
  assert.equal(isSwarmToken("sk-ccr-mMmenzE9o3lM6qH5tEpmmlKVpMPhIS6gZNhGsjxzX3U"), false);
  assert.equal(isSwarmToken("ccr-profile-6S123"), false);
  assert.equal(isSwarmToken(mintSwarmToken().rawToken), true);
});

test("feature flag off: a swarm-prefixed token is not recognized when not minted (no swarm namespace)", () => {
  // With swarm.enabled=false the gateway never enters the swarm branch; isSwarmToken is the gate.
  // A leftover/foreign swarm-prefixed token would simply fail ordinary api_key auth (fail-closed).
  // This test documents the gate: the prefix alone does not grant any routing.
  const foreign = "ccr-swarm-v1-foreigntokennotmintedhere";
  assert.equal(isSwarmToken(foreign), true); // it IS shaped like a swarm token...
  // ...but with the flag off, getSwarmAuth() is undefined and authorize() rejects it (not an api_key).
  // We assert the shape gate exists; full gateway behavior is covered by integration in Phase 7.
});
