/**
 * Swarm Session launcher integration (Phase 3, revised Phase 7B).
 *
 * A Swarm launch does NOT create an Agent ProfileConfig row and does NOT touch the user's global
 * ~/.claude/settings.json. It derives an EPHEMERAL runtime config directly from the Swarm Profile.
 *
 * TOKEN DELIVERY (Phase 7B): Claude Code, when subscription-logged-in, prefers the keychain OAuth
 * bearer and does NOT reliably honor `apiKeyHelper` (verified: `--bare`, `CLAUDE_CODE_SIMPLE=1`,
 * and `--settings` all still sent only `authorization: Bearer <oauth>` with no Swarm `x-api-key`).
 * No Claude Code flag forces apiKeyHelper under OAuth. So instead of relying on Claude Code to send
 * the token, a small LOCAL LOOPBACK TOKEN PROXY is spawned between Claude Code and the gateway:
 *   Claude Code -> http://127.0.0.1:<proxyPort>  (no token in Claude Code's env)
 *   proxy reads the Swarm token from a 0600 file, injects `x-api-key`, forwards to the gateway.
 * The raw token lives ONLY in the 0600 token file (read into proxy memory per request). It is never
 * in Claude Code's env, argv, logs, SQLite (only its sha256 hash), or diagnostics.
 *
 * Raw-token handling: the token file is mode 0600 inside the per-session temp dir; both the proxy
 * process and the temp dir are torn down on session stop (cross-process safe via a pidfile + the
 * deterministic runtime dir path). Rotation rewrites the token file in place; the proxy re-reads it.
 *
 * Routing: no ANTHROPIC_MODEL is asserted in env — CCR decides routing from the Swarm Profile.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SwarmLauncherType, SwarmSession } from "@ccr/core/swarm/contracts";
import type { SwarmStore } from "@ccr/core/swarm/store";
import { SWARM_SESSION_DEFAULT_TTL_MS } from "@ccr/core/swarm/session";
import { mintSwarmToken } from "@ccr/core/swarm/token";

const privateDirMode = 0o700;
const privateFileMode = 0o600;

export type CreateSwarmSessionParams = {
  swarmId: string;
  workspace: string;
  launchDirectory: string;
  launcherType?: SwarmLauncherType;
  ttlMs?: number;
  processId?: number | null;
};

export type CreatedSwarmSession = {
  /** Raw token — pass to buildSwarmLaunchRuntime; never persist/log/export. */
  rawToken: string;
  session: SwarmSession;
};

/** Mint a token, persist its hash + session record, return the raw token to the launcher. */
export async function createSwarmSession(
  store: SwarmStore,
  params: CreateSwarmSessionParams
): Promise<CreatedSwarmSession> {
  const { rawToken, tokenHash } = mintSwarmToken();
  const id = `swrm_${randomBytes(12).toString("base64url")}`;
  const now = new Date().toISOString();
  const session: SwarmSession = {
    id,
    swarmId: params.swarmId,
    authTokenHash: tokenHash,
    workspace: params.workspace,
    launchDirectory: params.launchDirectory,
    processId: params.processId ?? null,
    claudeSessionId: "",
    startedAt: now,
    lastSeenAt: now,
    endedAt: "",
    status: "active",
    launcherType: params.launcherType ?? "desktop",
    ttlMs: params.ttlMs ?? SWARM_SESSION_DEFAULT_TTL_MS
  };
  await store.upsertSession(session);
  return { rawToken, session };
}

export type SwarmLaunchRuntime = {
  /** Per-session temp CLAUDE_CONFIG_DIR (under the CCR config dir). Deleted on stop. */
  tempConfigDir: string;
  /** 0600 file holding the raw Swarm token (read by the proxy; never in env/argv). */
  tokenFile: string;
  /** Self-contained proxy script (no token embedded; spawned as a child process). */
  proxyScript: string;
  /** pidfile for the proxy child (cross-process stop). */
  pidFile: string;
  settingsFile: string;
  env: Record<string, string>;
};

/**
 * Build the ephemeral runtime config for a launched Claude Code process.
 * Writes ONLY under `<configDir>/swarm-runtime/<sessionId>` — never touches global settings.
 * `gatewayEndpoint` is the URL Claude Code will point at; launch() overrides it with the proxy URL.
 */
export function buildSwarmLaunchRuntime(args: {
  session: SwarmSession;
  rawToken: string;
  gatewayEndpoint: string;
  configDir: string;
}): SwarmLaunchRuntime {
  const tempConfigDir = path.join(args.configDir, "swarm-runtime", args.session.id);
  mkdirSync(tempConfigDir, { mode: privateDirMode, recursive: true });

  const tokenFile = path.join(tempConfigDir, "swarm-token");
  const proxyScript = path.join(tempConfigDir, "token-proxy.cjs");
  const pidFile = path.join(tempConfigDir, "proxy.pid");
  const settingsFile = path.join(tempConfigDir, "settings.json");

  // Raw token in a 0600 file only. The proxy reads this per request (rotation: rewrite in place).
  writeFileSync(tokenFile, args.rawToken, { mode: privateFileMode });
  chmodSync(tokenFile, privateFileMode);

  // Self-contained proxy script. NO token is embedded; it reads tokenFile at runtime.
  writeFileSync(proxyScript, SWARM_TOKEN_PROXY_SCRIPT, { mode: 0o755 });

  // Minimal settings: the proxy injects auth, so no apiKeyHelper. CLAUDE_CONFIG_DIR isolates state.
  writeFileSync(settingsFile, JSON.stringify({ env: {} }), { mode: privateFileMode });
  chmodSync(settingsFile, privateFileMode);

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: args.gatewayEndpoint,
    ANTHROPIC_API_BASE_URL: args.gatewayEndpoint,
    CLAUDE_AGENT_API_BASE_URL: args.gatewayEndpoint,
    CLAUDE_CONFIG_DIR: tempConfigDir,
    // Informative only; routing is decided by CCR from the resolved Swarm Session, not these.
    CCR_SWARM_SESSION_ID: args.session.id,
    CCR_SWARM_ID: args.session.swarmId
  };
  return { tempConfigDir, tokenFile, proxyScript, pidFile, settingsFile, env };
}

export type SwarmTokenProxy = { port: number; pid: number };

/**
 * Spawn the loopback token proxy as a detached child. It reads the token from `tokenFile` (0600),
 * injects `x-api-key` on every request, and forwards to the gateway. Detached so it survives the
 * launcher process; the pidfile lets any process stop it. Returns the chosen loopback port.
 */
export async function spawnSwarmTokenProxy(opts: {
  proxyScript: string;
  tokenFile: string;
  upstreamHost: string;
  upstreamPort: number;
  pidFile: string;
}): Promise<SwarmTokenProxy> {
  const child = spawn(
    process.execPath,
    [opts.proxyScript, opts.tokenFile, opts.upstreamHost, String(opts.upstreamPort)],
    { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("swarm token proxy did not report a port")),
      8000
    );
    child.stdout?.on("data", (data: Buffer) => {
      const parsed = parseInt(data.toString().trim().split("\n")[0], 10);
      if (parsed > 0) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`swarm token proxy exited before listening (code ${code})`));
    });
  });
  const pid = child.pid ?? 0;
  try {
    writeFileSync(opts.pidFile, String(pid), { mode: privateFileMode });
  } catch {
    // best-effort
  }
  child.unref();
  child.stdout?.destroy();
  return { port, pid };
}

/** In-process proxy factory (used by integration tests; production uses the spawned child). */
export async function createInProcessSwarmTokenProxy(opts: {
  tokenFile: string;
  upstreamHost: string;
  upstreamPort: number;
}): Promise<SwarmTokenProxy & { server: http.Server }> {
  const server = http.createServer((req, res) => {
    forwardWithToken(req, res, opts.tokenFile, opts.upstreamHost, opts.upstreamPort);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, pid: 0, server };
}

function forwardWithToken(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tokenFile: string,
  upstreamHost: string,
  upstreamPort: number
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("error", () => {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  });
  req.on("end", () => {
    let token = "";
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch {
      token = "";
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    if (token) {
      headers["x-api-key"] = token;
    }
    const upstream = http.request(
      { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers },
      (upRes) => {
        try {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        } catch {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        }
      }
    );
    upstream.on("error", () => {
      try {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { type: "swarm_token_proxy", message: "upstream unavailable" } })
        );
      } catch {
        /* ignore */
      }
    });
    upstream.end(Buffer.concat(chunks));
  });
}

/** Stop (revoke) a session, kill its proxy, and delete the ephemeral runtime dir. */
export async function stopSwarmSession(store: SwarmStore, sessionId: string, runtimeDir?: string): Promise<void> {
  await store.updateSessionStatus(sessionId, "stopped", new Date().toISOString());
  if (runtimeDir) {
    killSwarmTokenProxy(path.join(runtimeDir, "proxy.pid"));
    disposeSwarmLaunchRuntime(runtimeDir);
  }
}

/** Best-effort SIGTERM to the proxy child recorded in the pidfile. Safe if absent/already-dead. */
export function killSwarmTokenProxy(pidFile: string): void {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
  } catch {
    /* no pidfile */
  }
}

/** Delete the ephemeral runtime dir (0600 token file + proxy script + temp settings). */
export function disposeSwarmLaunchRuntime(tempConfigDir: string): void {
  try {
    rmSync(tempConfigDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Self-contained CommonJS proxy script. Spawned as a detached child (ELECTRON_RUN_AS_NODE=1).
 * argv: tokenFile upstreamHost upstreamPort. Reads the token from tokenFile on EVERY request
 * (rotation support), injects x-api-key, forwards to the gateway. Never logs the token.
 * Printed to stdout: the chosen loopback port (first line).
 */
const SWARM_TOKEN_PROXY_SCRIPT = `#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const [tokenFile, upstreamHost, upstreamPortStr] = process.argv.slice(2);
const upstreamPort = parseInt(upstreamPortStr, 10);
if (!tokenFile || !upstreamHost || !upstreamPort) {
  process.stderr.write("usage: token-proxy.cjs <tokenFile> <upstreamHost> <upstreamPort>\\n");
  process.exit(1);
}
function readToken() {
  try { return fs.readFileSync(tokenFile, "utf8").trim(); } catch { return ""; }
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const token = readToken();
    const headers = Object.assign({}, req.headers);
    if (token) headers["x-api-key"] = token;
    const up = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on("error", () => {
      try { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "swarm_token_proxy", message: "upstream unavailable" } })); } catch (e) {}
    });
    up.end(Buffer.concat(chunks));
  });
});
server.on("error", (e) => { process.stderr.write("proxy error: " + e.message + "\\n"); process.exit(1); });
server.listen(0, "127.0.0.1", () => { process.stdout.write(String(server.address().port) + "\\n"); });
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;
