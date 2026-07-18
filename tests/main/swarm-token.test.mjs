import assert from "node:assert/strict";
import test from "node:test";
import {
  SWARM_TOKEN_PREFIX,
  SWARM_TOKEN_RANDOM_BYTES,
  hashSwarmToken,
  isSwarmToken,
  mintSwarmToken,
  swarmTokenHashesEqual
} from "../../packages/core/src/swarm/token.ts";

test("mintSwarmToken produces a versioned, typed token with a sha256 hash", () => {
  const { rawToken, tokenHash } = mintSwarmToken();
  assert.ok(rawToken.startsWith(SWARM_TOKEN_PREFIX), "must carry the versioned type prefix");
  // base64url of 32 random bytes is 43 chars (no padding)
  assert.equal(rawToken.length, SWARM_TOKEN_PREFIX.length + 43);
  assert.equal(tokenHash.length, 64);
  assert.equal(tokenHash, hashSwarmToken(rawToken));
});

test("mintSwarmToken has 256 bits of entropy ( CSPRNG, non-repeating)", () => {
  const tokens = new Set(Array.from({ length: 64 }, () => mintSwarmToken().rawToken));
  assert.equal(tokens.size, 64);
});

test("isSwarmToken recognizes only the swarm namespace prefix", () => {
  const { rawToken } = mintSwarmToken();
  assert.equal(isSwarmToken(rawToken), true);
  assert.equal(isSwarmToken("sk-ccr-abc123"), false);
  assert.equal(isSwarmToken("ccr-profile-xyz"), false);
  assert.equal(isSwarmToken(undefined), false);
  assert.equal(isSwarmToken(null), false);
});

test("swarmTokenHashesEqual is constant-time correct and never throws", () => {
  const { tokenHash } = mintSwarmToken();
  assert.equal(swarmTokenHashesEqual(tokenHash, tokenHash), true);
  const { tokenHash: other } = mintSwarmToken();
  assert.equal(swarmTokenHashesEqual(tokenHash, other), false);
  // length mismatch must not throw
  assert.equal(swarmTokenHashesEqual("deadbeef", tokenHash), false);
  assert.equal(swarmTokenHashesEqual("not-hex-but-64-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenHash), false);
});

test("hashSwarmToken is deterministic", () => {
  const { rawToken, tokenHash } = mintSwarmToken();
  assert.equal(hashSwarmToken(rawToken), tokenHash);
  assert.equal(hashSwarmToken(rawToken), hashSwarmToken(rawToken));
});
