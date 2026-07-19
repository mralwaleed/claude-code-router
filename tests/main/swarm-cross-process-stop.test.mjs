/**
 * Commit-3 regression: cross-process session stop cleans the runtime dir.
 *
 * Bug #5: stopping a session from a different process (no in-memory launchedRuntimeDirs map)
 * must still remove the deterministic runtime dir + token file.
 *
 * The test forces CCR_SWARM_FAKE_LAUNCH=1 so launch() uses the FakeLaunchAdapter and skips the
 * real proxy spawn + Terminal open — keeping the unit test hermetic while still exercising the
 * real runtime-dir creation (buildSwarmLaunchRuntime) and cross-process removal (stopSession).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmManagement } from "../../packages/core/src/swarm/manage.ts";
import { SwarmStore } from "../../packages/core/src/swarm/store.ts";

const PROVIDERS = [
  { id: "prov-a", name: "Provider A", models: ["model-a"] },
  { id: "prov-b", name: "Provider B", models: ["model-b"] }
];

test("#5 cross-process stop removes the runtime dir + token file (deterministic path)", async () => {
  const prevFakeLaunch = process.env.CCR_SWARM_FAKE_LAUNCH;
  process.env.CCR_SWARM_FAKE_LAUNCH = "1";
  try {
    const storeDir = mkdtempSync(path.join(tmpdir(), "swarm-v5s-"));
    const configDir = mkdtempSync(path.join(tmpdir(), "swarm-v5c-"));
    const launchDir = mkdtempSync(path.join(tmpdir(), "swarm-v5l-"));
    const store = new SwarmStore(path.join(storeDir, "swarms.sqlite"));
    // "Process A": create + launch.
    const mgmtA = new SwarmManagement(store, configDir, "http://127.0.0.1:3456", PROVIDERS, undefined, false);
    const profile = await mgmtA.createProfile({
      name: "P", description: "", enabled: true, workspaceRoots: [launchDir], launchDirectory: launchDir,
      mainInstructionFile: "", agentDirectories: [], leaderProviderId: "prov-a", leaderModel: "model-a",
      defaultProviderId: "prov-a", defaultModel: "model-a", fallbackProviderId: "", fallbackModel: "",
      routingMode: "exact", fallbackPolicy: "existing-ccr", autoDetectWorkspace: false, watchFiles: false, agentOverrides: {}
    });
    const launched = await mgmtA.launch(profile.id);
    assert.ok(launched.ok && launched.session);
    const sessionId = launched.session.id;
    const runtimeDir = path.join(configDir, "swarm-runtime", sessionId);
    assert.ok(existsSync(runtimeDir), "runtime dir created on launch");
    // Fresh SwarmManagement (no in-memory state) — simulates a different process stopping it.
    const mgmtB = new SwarmManagement(store, configDir, "http://127.0.0.1:3456", PROVIDERS, undefined, false);
    const stopped = await mgmtB.stopSession(sessionId);
    assert.equal(stopped.ok, true);
    assert.equal(existsSync(runtimeDir), false, "runtime dir removed by cross-process stop (#5)");
    assert.equal(existsSync(path.join(runtimeDir, "swarm-token")), false, "token file removed (#5)");
  } finally {
    if (prevFakeLaunch === undefined) {
      delete process.env.CCR_SWARM_FAKE_LAUNCH;
    } else {
      process.env.CCR_SWARM_FAKE_LAUNCH = prevFakeLaunch;
    }
  }
});
