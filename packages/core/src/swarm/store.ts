/**
 * Versioned Swarm persistence (Phase 1).
 *
 * Storage shape: each entity table has structured/index columns PLUS a `*_json` doc column
 * holding the full typed entity. The doc column is the source of truth for round-trip fidelity
 * (so unknown fields from a newer schema are preserved when an older build re-saves), while the
 * index columns support queries. Entity validation lives in swarm/validation.ts, not here.
 *
 * Fail-open: the store NEVER throws out of its public methods. If the DB cannot be opened or a
 * query fails, the store goes "degraded": reads return empty/undefined and writes are no-ops.
 * The gateway therefore cannot be broken by Swarm persistence problems (requirement 15).
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SWARM_SCHEMA_VERSION } from "@ccr/core/swarm/contracts";
import { createBetterSqliteDatabase, type BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";
import type {
  SwarmAgent,
  SwarmAttribution,
  SwarmProfile,
  SwarmSession
} from "@ccr/core/swarm/contracts";

/** Ensure forward-compat: old profiles may lack fallbackPolicy / agentOverrides. */
function normalizeProfile(profile: SwarmProfile): SwarmProfile {
  return {
    ...profile,
    fallbackPolicy: profile.fallbackPolicy ?? "existing-ccr",
    agentOverrides: profile.agentOverrides ?? {}
  };
}

type SqlDatabase = BetterSqliteDatabase;
type SqlValue = bigint | Buffer | number | string | null;

const privateDirMode = 0o700;
const privateFileMode = 0o600;

export type SwarmStoreStatus = "ok" | "degraded";

export class SwarmStore {
  private database?: SqlDatabase;
  private initPromise?: Promise<SqlDatabase | undefined>;
  private degraded = false;
  private degradeReasonText = "";

  constructor(private readonly dbFile: string) {}

  get status(): SwarmStoreStatus {
    return this.degraded ? "degraded" : "ok";
  }

  get degradeReason(): string {
    return this.degradeReasonText;
  }

  // ---- Profiles ----

  async listProfiles(): Promise<SwarmProfile[]> {
    return this.run([], (db) =>
      queryRows(db, "SELECT profile_json FROM swarm_profiles ORDER BY name, rowid")
        .map((row) => parseJson<SwarmProfile>(row.profile_json))
        .filter((value): value is SwarmProfile => Boolean(value))
        .map(normalizeProfile)
    );
  }

  async getProfile(id: string): Promise<SwarmProfile | undefined> {
    return this.run(undefined, (db) => {
      const rows = queryRows(db, "SELECT profile_json FROM swarm_profiles WHERE id = ?", [id]);
      if (!rows.length) return undefined;
      const profile = parseJson<SwarmProfile>(rows[0].profile_json);
      return profile ? normalizeProfile(profile) : undefined;
    });
  }

  async upsertProfile(profile: SwarmProfile): Promise<SwarmProfile | undefined> {
    return this.run(undefined, (db) => {
      db.prepare(
        `INSERT OR REPLACE INTO swarm_profiles (id, name, enabled, created_at, updated_at, profile_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(profile.id, profile.name, profile.enabled ? 1 : 0, profile.createdAt, profile.updatedAt, JSON.stringify(profile));
      return profile;
    });
  }

  async deleteProfile(id: string): Promise<boolean> {
    return this.run(false, (db) => {
      const txn = db.transaction(() => {
        db.prepare("DELETE FROM swarm_agents WHERE swarm_id = ?").run(id);
        db.prepare("DELETE FROM swarm_profiles WHERE id = ?").run(id);
      });
      txn();
      return true;
    });
  }

  // ---- Agents ----

  async listAgents(swarmId: string): Promise<SwarmAgent[]> {
    return this.run([], (db) =>
      queryRows(db, "SELECT agent_json FROM swarm_agents WHERE swarm_id = ? ORDER BY slug, rowid", [swarmId])
        .map((row) => parseJson<SwarmAgent>(row.agent_json))
        .filter((value): value is SwarmAgent => Boolean(value))
    );
  }

  /** Replace the full agent set for a swarm (used by the registry after a scan). */
  async replaceAgents(swarmId: string, agents: SwarmAgent[]): Promise<SwarmAgent[]> {
    return this.run([], (db) => {
      const txn = db.transaction(() => {
        db.prepare("DELETE FROM swarm_agents WHERE swarm_id = ?").run(swarmId);
        const stmt = db.prepare(
          `INSERT INTO swarm_agents (id, swarm_id, slug, enabled, body_hash, validation_status, last_modified_at, agent_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const agent of agents) {
          stmt.run(
            agent.id,
            swarmId,
            agent.slug,
            agent.enabled ? 1 : 0,
            agent.bodyHash || "",
            agent.validationStatus,
            agent.lastModifiedAt,
            JSON.stringify(agent)
          );
        }
      });
      txn();
      return agents;
    });
  }

  // ---- Sessions ----

  async upsertSession(session: SwarmSession): Promise<SwarmSession | undefined> {
    return this.run(undefined, (db) => {
      db.prepare(
        `INSERT OR REPLACE INTO swarm_sessions (id, swarm_id, auth_token_hash, status, started_at, last_seen_at, session_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        session.id,
        session.swarmId,
        session.authTokenHash,
        session.status,
        session.startedAt,
        session.lastSeenAt,
        JSON.stringify(session)
      );
      return session;
    });
  }

  async getSessionById(id: string): Promise<SwarmSession | undefined> {
    return this.run(undefined, (db) => {
      const rows = queryRows(db, "SELECT session_json FROM swarm_sessions WHERE id = ?", [id]);
      return rows.length ? parseJson<SwarmSession>(rows[0].session_json) ?? undefined : undefined;
    });
  }

  /** Resolve a session by auth token hash (constant-time comparison happens before this call). */
  async getSessionByTokenHash(tokenHash: string): Promise<SwarmSession | undefined> {
    return this.run(undefined, (db) => {
      const rows = queryRows(db, "SELECT session_json FROM swarm_sessions WHERE auth_token_hash = ?", [tokenHash]);
      return rows.length ? parseJson<SwarmSession>(rows[0].session_json) ?? undefined : undefined;
    });
  }

  async listActiveSessions(): Promise<SwarmSession[]> {
    return this.run([], (db) =>
      queryRows(db, "SELECT session_json FROM swarm_sessions WHERE status IN ('active','reattached') ORDER BY last_seen_at DESC")
        .map((row) => parseJson<SwarmSession>(row.session_json))
        .filter((value): value is SwarmSession => Boolean(value))
    );
  }

  /** All sessions (any status) — used for deterministic restart recovery. */
  async listSessions(): Promise<SwarmSession[]> {
    return this.run([], (db) =>
      queryRows(db, "SELECT session_json FROM swarm_sessions ORDER BY started_at DESC")
        .map((row) => parseJson<SwarmSession>(row.session_json))
        .filter((value): value is SwarmSession => Boolean(value))
    );
  }

  /** Bind a Claude Code session id to a session (once). No-op if already bound to the same id. */
  async bindClaudeSession(sessionId: string, claudeSessionId: string): Promise<boolean> {
    return this.run(false, (db) => {
      const rows = queryRows(db, "SELECT session_json FROM swarm_sessions WHERE id = ?", [sessionId]);
      if (!rows.length) {
        return false;
      }
      const session = parseJson<SwarmSession>(rows[0].session_json);
      if (!session) {
        return false;
      }
      if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
        return false; // already bound to a different id — refuse rebinding
      }
      if (session.claudeSessionId === claudeSessionId) {
        return true; // already bound to the same id
      }
      session.claudeSessionId = claudeSessionId;
      db.prepare("UPDATE swarm_sessions SET session_json = ? WHERE id = ?").run(JSON.stringify(session), sessionId);
      return true;
    });
  }

  async updateSessionStatus(id: string, status: SwarmSession["status"], endedAt: string): Promise<void> {
    await this.run(undefined, (db) => {
      const rows = queryRows(db, "SELECT session_json FROM swarm_sessions WHERE id = ?", [id]);
      if (!rows.length) {
        return;
      }
      const session = parseJson<SwarmSession>(rows[0].session_json);
      if (!session) {
        return;
      }
      session.status = status;
      session.endedAt = endedAt;
      db.prepare("UPDATE swarm_sessions SET status = ?, session_json = ? WHERE id = ?").run(
        status,
        JSON.stringify(session),
        id
      );
    });
  }

  async touchSession(id: string, lastSeenAt: string): Promise<void> {
    await this.run(undefined, (db) => {
      const rows = queryRows(db, "SELECT session_json FROM swarm_sessions WHERE id = ?", [id]);
      if (!rows.length) {
        return;
      }
      const session = parseJson<SwarmSession>(rows[0].session_json);
      if (!session) {
        return;
      }
      session.lastSeenAt = lastSeenAt;
      db.prepare("UPDATE swarm_sessions SET last_seen_at = ?, session_json = ? WHERE id = ?").run(
        lastSeenAt,
        JSON.stringify(session),
        id
      );
    });
  }

  // ---- Attributions ----

  async recordAttribution(attribution: SwarmAttribution): Promise<void> {
    await this.run(undefined, (db) => {
      db.prepare(
        `INSERT INTO swarm_attributions (request_id, swarm_session_id, swarm_id, agent_id, confidence, method, detector_version, routing_reason, fallback_reason, created_at, attribution_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        attribution.requestId,
        attribution.swarmSessionId,
        attribution.swarmId,
        attribution.agentId,
        attribution.classification,
        attribution.attributionMethod,
        attribution.detectorVersion,
        attribution.routingReason,
        attribution.fallbackReason,
        attribution.createdAt,
        JSON.stringify(attribution)
      );
    });
  }

  /** Lightweight COUNT of attributions for a session (indexed, no full scan). */
  async countAttributionsBySession(sessionId: string): Promise<number> {
    return this.run(0, (db) => {
      const rows = queryRows(db, "SELECT COUNT(*) as n FROM swarm_attributions WHERE swarm_session_id = ?", [sessionId]);
      return Number(rows[0]?.n ?? 0);
    });
  }

  async listAttributionsBySession(swarmSessionId: string, limit = 50): Promise<SwarmAttribution[]> {
    return this.run([], (db) =>
      queryRows(
        db,
        "SELECT attribution_json FROM swarm_attributions WHERE swarm_session_id = ? ORDER BY id DESC LIMIT ?",
        [swarmSessionId, limit]
      )
        .map((row) => parseJson<SwarmAttribution>(row.attribution_json))
        .filter((value): value is SwarmAttribution => Boolean(value))
    );
  }

  // ---- Internals ----

  private async run<T>(fallback: T, fn: (db: SqlDatabase) => T): Promise<T> {
    const database = await this.getDatabase();
    if (!database) {
      return fallback;
    }
    try {
      return fn(database);
    } catch (error) {
      this.markDegraded(error);
      return fallback;
    }
  }

  private async getDatabase(): Promise<SqlDatabase | undefined> {
    if (this.degraded) {
      return undefined;
    }
    if (this.database) {
      return this.database;
    }
    this.initPromise ??= this.open();
    try {
      const database = await this.initPromise;
      return database;
    } catch (error) {
      this.markDegraded(error);
      return undefined;
    }
  }

  private async open(): Promise<SqlDatabase> {
    mkdirSync(dirname(this.dbFile), { mode: privateDirMode, recursive: true });
    securePathPermissions(dirname(this.dbFile), privateDirMode);
    const database = createBetterSqliteDatabase(this.dbFile);
    configureSqliteDatabase(database);
    ensureSwarmSchema(database);
    secureDatabaseFilePermissions(this.dbFile);
    this.database = database;
    return database;
  }

  private markDegraded(error: unknown): void {
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    this.degradeReasonText = error instanceof Error ? error.message : String(error);
    this.database = undefined;
    // eslint-disable-next-line no-console
    console.warn(`[swarm] SwarmStore degraded (fail-open): ${this.degradeReason}`);
  }
}

function ensureSwarmSchema(database: SqlDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS swarm_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swarm_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      profile_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS swarm_profiles_enabled_idx ON swarm_profiles(enabled);

    CREATE TABLE IF NOT EXISTS swarm_agents (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      body_hash TEXT NOT NULL DEFAULT '',
      validation_status TEXT NOT NULL DEFAULT 'ok',
      last_modified_at TEXT NOT NULL DEFAULT '',
      agent_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS swarm_agents_swarm_id_idx ON swarm_agents(swarm_id);
    CREATE INDEX IF NOT EXISTS swarm_agents_swarm_hash_idx ON swarm_agents(swarm_id, body_hash);

    CREATE TABLE IF NOT EXISTS swarm_sessions (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL,
      auth_token_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      session_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS swarm_sessions_token_hash_idx ON swarm_sessions(auth_token_hash);
    CREATE INDEX IF NOT EXISTS swarm_sessions_status_idx ON swarm_sessions(status);
    CREATE INDEX IF NOT EXISTS swarm_sessions_swarm_id_idx ON swarm_sessions(swarm_id);

    CREATE TABLE IF NOT EXISTS swarm_attributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL DEFAULT '',
      swarm_session_id TEXT NOT NULL,
      swarm_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'unknown',
      method TEXT NOT NULL DEFAULT '',
      detector_version TEXT NOT NULL DEFAULT '',
      routing_reason TEXT NOT NULL DEFAULT '',
      fallback_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      attribution_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS swarm_attributions_session_idx ON swarm_attributions(swarm_session_id, id);
  `);

  // Record / advance schema version. Future additive migrations (ALTER TABLE ... ) would be
  // applied here, gated by the installed version, before updating swarm_meta.
  const installed = readSchemaVersion(database);
  if (installed < SWARM_SCHEMA_VERSION) {
    // (no v1->v2 migrations yet; this is the hook for them)
    writeSchemaVersion(database, SWARM_SCHEMA_VERSION);
  }
}

function readSchemaVersion(database: SqlDatabase): number {
  const rows = queryRows(database, "SELECT value_json FROM swarm_meta WHERE key = 'schema_version'");
  if (!rows.length) {
    return 0;
  }
  const parsed = parseJson<number>(rows[0].value_json);
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

function writeSchemaVersion(database: SqlDatabase, version: number): void {
  database.prepare("INSERT OR REPLACE INTO swarm_meta (key, value_json) VALUES ('schema_version', ?)").run(
    JSON.stringify(version)
  );
}

function configureSqliteDatabase(database: SqlDatabase): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
}

function queryRows(database: SqlDatabase, sql: string, params: SqlValue[] = []): Array<Record<string, SqlValue>> {
  return database.prepare(sql).all(...params) as Array<Record<string, SqlValue>>;
}

function parseJson<T>(value: SqlValue): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function secureDatabaseFilePermissions(file: string): void {
  securePathPermissions(file, privateFileMode);
  securePathPermissions(`${file}-wal`, privateFileMode);
  securePathPermissions(`${file}-shm`, privateFileMode);
}

function securePathPermissions(file: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  if (!existsSync(file)) {
    return;
  }
  try {
    chmodSync(file, mode);
  } catch {
    // best-effort
  }
}
