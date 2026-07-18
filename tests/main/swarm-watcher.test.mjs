import assert from "node:assert/strict";
import { mkdtempSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwarmAgentWatcher } from "../../packages/core/src/swarm/watcher.ts";

const WAIT_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWatcher(dir, debounceMs = 120) {
  const events = [];
  let resolveEvent = null;
  const watcher = new SwarmAgentWatcher({
    directories: [dir],
    debounceMs,
    onChange: (reason) => {
      events.push(reason);
      if (resolveEvent) {
        const r = resolveEvent;
        resolveEvent = null;
        r(reason);
      }
    }
  });
  const next = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("watcher event timeout")), WAIT_MS);
      resolveEvent = (reason) => {
        clearTimeout(timer);
        resolve(reason);
      };
    });
  return { watcher, events, next };
}

test("watcher fires on add, change, unlink and coalesces burst writes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-watch-"));
  const { watcher, next } = makeWatcher(dir);
  watcher.start();
  await sleep(500); // let chokidar initialize

  const file = path.join(dir, "agent.md");
  writeFileSync(file, "# Agent v1");
  await next(); // add

  // burst: several quick writes -> ONE coalesced event
  const burstP = next();
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(file, `# Agent v${i + 2}`);
    await sleep(25);
  }
  await burstP;

  // unlink
  const unlinkP = next();
  unlinkSync(file);
  await unlinkP;

  await watcher.stop();
  assert.equal(watcher.status, "stopped");
});

test("watcher handles atomic-save (temp + rename)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-watch-atomic-"));
  const file = path.join(dir, "atomic.md");
  writeFileSync(file, "# v1");
  const { watcher, next } = makeWatcher(dir);
  watcher.start();
  await sleep(500);

  const eventP = next();
  const tmp = path.join(dir, "atomic.tmp.md");
  writeFileSync(tmp, "# v2 atomic");
  renameSync(tmp, file); // atomic replace
  await eventP;
  await watcher.stop();
});

test("watcher ignores non-md / swap / backup files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "swarm-watch-ignore-"));
  const { watcher, events } = makeWatcher(dir);
  watcher.start();
  await sleep(500);

  writeFileSync(path.join(dir, "notes.txt"), "x");
  writeFileSync(path.join(dir, "agent.md.bak"), "x");
  writeFileSync(path.join(dir, ".swap.md.swp"), "x");
  await sleep(700);
  assert.equal(events.length, 0, "watcher must not fire for ignored file types");
  await watcher.stop();
});
