/**
 * Swarm launch token format (Phase 3).
 *
 * Tokens are SESSION CREDENTIALS, not user secrets. They are minted by the launcher, handed to
 * the launched Claude Code process via its apiKeyHelper, hashed at rest, and never persisted,
 * logged, exported, or shown in diagnostics in raw form.
 *
 * Format:  ccr-swarm-v1-<base64url(randomBytes)>
 *   - prefix "ccr-swarm-v1-": explicit token type + version (so the gateway can route it into
 *     the dedicated Swarm auth namespace, distinct from provider API keys)
 *   - SWARM_TOKEN_RANDOM_BYTES = 32 (256 bits) from crypto.randomBytes (CSPRNG)
 *   - stored as sha256(rawToken) hex (OWASP-recommended server-side credential hashing)
 *
 * Comparison is constant-time (crypto.timingSafeEqual over the fixed-length sha256 buffers).
 * Lookup by hash is a normal SQLite index probe (hashes are 256-bit, not enumerable cross-user).
 *
 * Entropy: 256 bits — brute-force/inenumerable. Versioning: bump the prefix + add migration on
 * any format change (e.g. v2 algorithm).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SWARM_TOKEN_PREFIX = "ccr-swarm-v1-";
/** CSPRNG byte length for the random portion of a token (256 bits of entropy). */
export const SWARM_TOKEN_RANDOM_BYTES = 32;
const SHA256_HEX_LENGTH = 64;

export type MintedSwarmToken = {
  /** Raw token. Lives ONLY in the launcher → helper → child process env. Never persisted. */
  rawToken: string;
  /** sha256(rawToken) hex. Safe to persist (swarm_sessions.auth_token_hash). */
  tokenHash: string;
};

/** Mint a fresh launch token + its sha256 hash. */
export function mintSwarmToken(): MintedSwarmToken {
  const bytes = randomBytes(SWARM_TOKEN_RANDOM_BYTES);
  const rawToken = SWARM_TOKEN_PREFIX + bytes.toString("base64url");
  return { rawToken, tokenHash: hashSwarmToken(rawToken) };
}

/** sha256 hex of a raw token. */
export function hashSwarmToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** A token belongs to the Swarm auth namespace iff it carries the versioned prefix. */
export function isSwarmToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.startsWith(SWARM_TOKEN_PREFIX);
}

/**
 * Constant-time equality of two sha256 hex hashes. Returns false (not throws) on length mismatch
 * so callers cannot infer validity from exceptions.
 */
export function swarmTokenHashesEqual(a: string, b: string): boolean {
  if (a.length !== SHA256_HEX_LENGTH || b.length !== SHA256_HEX_LENGTH) {
    return false;
  }
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
