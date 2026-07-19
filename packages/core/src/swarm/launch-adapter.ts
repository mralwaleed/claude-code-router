/**
 * Injectable launch adapter for Swarm sessions (Phase 5A.4).
 *
 * Abstracts the process-spawn behavior so tests can use a deterministic fake
 * without spawning real Terminal/Claude. Production uses TerminalLaunchAdapter.
 * The adapter NEVER receives the raw token (it only gets the launch script path).
 */
import { spawn } from "node:child_process";

export type SwarmLaunchInput = {
  /** Path to the launcher script (carries env via CLAUDE_CONFIG_DIR, NOT the token inline). */
  launchScript: string;
  launchDirectory: string;
};

export type SwarmLaunchResult = {
  pid: number | null;
};

export interface SwarmLaunchAdapter {
  launch(input: SwarmLaunchInput): SwarmLaunchResult;
}

/** Production adapter: opens Terminal.app (macOS) or spawns sh (other platforms). */
export class TerminalLaunchAdapter implements SwarmLaunchAdapter {
  launch(input: SwarmLaunchInput): SwarmLaunchResult {
    const child =
      process.platform === "darwin"
        ? spawn("open", ["-a", "Terminal.app", input.launchScript], { detached: true, stdio: "ignore" })
        : spawn("sh", [input.launchScript], { cwd: input.launchDirectory, detached: true, stdio: "ignore" });
    child.unref();
    return { pid: child.pid ?? null };
  }
}

/** Test adapter: deterministic, no real process, records calls for assertions. */
export class FakeLaunchAdapter implements SwarmLaunchAdapter {
  readonly calls: SwarmLaunchInput[] = [];
  shouldFail = false;
  fakePid = 99999;

  launch(input: SwarmLaunchInput): SwarmLaunchResult {
    this.calls.push(input);
    if (this.shouldFail) {
      throw new Error("Fake launch failure (configured)");
    }
    return { pid: this.fakePid };
  }
}
