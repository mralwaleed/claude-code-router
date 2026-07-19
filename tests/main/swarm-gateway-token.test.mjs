/**
 * Commit-1 regression: the gateway honors an explicit Swarm token.
 *
 * Bug #1: an explicit Swarm token in `x-api-key` must win over an unrelated OAuth
 * `authorization` bearer (so OAuth-logged-in sessions still authenticate to the Swarm namespace).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSwarmTokenForRequest } from "../../packages/core/src/gateway/service.ts";
import { mintSwarmToken } from "../../packages/core/src/swarm/token.ts";

test("#1 explicit Swarm token in x-api-key wins over OAuth authorization bearer", () => {
  const { rawToken } = mintSwarmToken();
  const oauth = "sk-oauth-bearer-abcdef";
  const resolved = resolveSwarmTokenForRequest({ authorization: `Bearer ${oauth}`, "x-api-key": rawToken });
  assert.equal(resolved, rawToken, "must pick the x-api-key Swarm token, not the OAuth bearer");
  assert.notEqual(resolved, oauth);
});

test("#1 falls back to authorization bearer when x-api-key is absent or non-swarm", () => {
  const { rawToken } = mintSwarmToken();
  assert.equal(resolveSwarmTokenForRequest({ authorization: `Bearer ${rawToken}` }), rawToken);
  assert.equal(resolveSwarmTokenForRequest({ "x-api-key": "sk-normal-key" }), "sk-normal-key");
  assert.equal(resolveSwarmTokenForRequest({}), undefined);
});
