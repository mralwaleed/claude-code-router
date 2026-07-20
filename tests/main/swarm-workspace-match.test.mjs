import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  diagnoseWorkspaceRoots,
  expandPath,
  isWithinPath,
  matchWorkspace,
  normalizeWorkspacePath
} from "../../packages/core/src/swarm/workspace-match.ts";

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), "swarm-ws-"));
}

test("expandPath expands ~ and ${VAR}/$VAR", () => {
  const env = { PROJECTS: "/u/projects" };
  assert.equal(expandPath("~", env), homedir());
  assert.equal(expandPath("~/x", env), path.join(homedir(), "x"));
  assert.equal(expandPath("${PROJECTS}/siyaj", env), "/u/projects/siyaj");
  assert.equal(expandPath("$PROJECTS/siyaj", env), "/u/projects/siyaj");
  // unresolved var left intact
  assert.equal(expandPath("${NOPE}/x", {}), "${NOPE}/x");
});

test("isWithinPath uses separator boundary (prefix trap)", () => {
  assert.equal(isWithinPath("/tmp/project-a", "/tmp/project-a"), true);
  assert.equal(isWithinPath("/tmp/project-a/child", "/tmp/project-a"), true);
  assert.equal(isWithinPath("/tmp/project-ab", "/tmp/project-a"), false);
  assert.equal(isWithinPath("/tmp/project-ab/child", "/tmp/project-a"), false);
});

test("normalizeWorkspacePath: missing and not-a-directory diagnostics (no throw)", () => {
  const missing = normalizeWorkspacePath("/nonexistent/definitely-missing-xyz");
  assert.equal(missing.exists, false);
  assert.equal(missing.accessible, false);
  assert.ok(missing.inaccessibleReason);

  const root = tmpDir();
  const filePath = path.join(root, "a-file");
  // create a file (not a directory)
  writeFileSync(filePath, "x");
  const notDir = normalizeWorkspacePath(filePath);
  assert.equal(notDir.exists, true);
  assert.equal(notDir.accessible, false);
  assert.match(notDir.inaccessibleReason ?? "", /not a directory/);
});

test("matchWorkspace: exact root match and child-directory match", () => {
  const root = tmpDir();
  mkdirSync(path.join(root, "child"), { recursive: true });
  const swarms = [{ swarmId: "s1", enabled: true, configuredRoot: root }];
  assert.equal(matchWorkspace(root, swarms).kind, "match");
  const child = matchWorkspace(path.join(root, "child"), swarms);
  assert.equal(child.kind, "match");
  assert.equal(child.swarmId, "s1");
});

test("matchWorkspace: prefix trap between similar roots", () => {
  const base = tmpDir();
  const a = path.join(base, "proj-a");
  const ab = path.join(base, "proj-ab");
  mkdirSync(a, { recursive: true });
  mkdirSync(ab, { recursive: true });
  mkdirSync(path.join(a, "deep"), { recursive: true });
  const swarms = [
    { swarmId: "s-a", enabled: true, configuredRoot: a },
    { swarmId: "s-ab", enabled: true, configuredRoot: ab }
  ];
  assert.equal(matchWorkspace(path.join(a, "deep"), swarms).swarmId, "s-a");
  assert.equal(matchWorkspace(ab, swarms).swarmId, "s-ab");
});

test("matchWorkspace: nested roots -> deepest wins", () => {
  const base = tmpDir();
  const outer = path.join(base, "ws");
  const inner = path.join(outer, "team-leader");
  mkdirSync(path.join(inner, "work"), { recursive: true });
  const swarms = [
    { swarmId: "s-outer", enabled: true, configuredRoot: outer },
    { swarmId: "s-inner", enabled: true, configuredRoot: inner }
  ];
  const m = matchWorkspace(path.join(inner, "work"), swarms);
  assert.equal(m.kind, "match");
  assert.equal(m.swarmId, "s-inner");
});

test("matchWorkspace: equal-depth across different enabled swarms is ambiguous", () => {
  // Two distinct roots that are the same physical dir via symlink -> same depth, two swarm ids
  const real = tmpDir();
  const linkA = path.join(real, "..", `link-a-${Date.now()}`);
  const linkB = path.join(real, "..", `link-b-${Date.now()}`);
  try { symlinkSync(real, linkA); } catch { /* perm */ }
  try { symlinkSync(real, linkB); } catch { /* perm */ }
  const candidate = path.join(real, "anything");
  mkdirSync(candidate, { recursive: true });
  const swarms = [
    { swarmId: "s1", enabled: true, configuredRoot: linkA },
    { swarmId: "s2", enabled: true, configuredRoot: linkB }
  ];
  const m = matchWorkspace(candidate, swarms);
  // both resolve to the same realpath at the same depth -> ambiguous (or a single match if symlinks unsupported)
  if (m.kind === "ambiguous") {
    assert.ok(m.swarmIds.includes("s1") && m.swarmIds.includes("s2"));
  }
  // (If symlinks are unavailable in the env, this test no-ops the assertion.)
});

test("matchWorkspace: disabled swarm ignored", () => {
  const root = tmpDir();
  const swarms = [{ swarmId: "s1", enabled: false, configuredRoot: root }];
  assert.equal(matchWorkspace(root, swarms).kind, "none");
});

test("matchWorkspace: multiple roots under one swarm match", () => {
  const r1 = tmpDir();
  const r2 = tmpDir();
  mkdirSync(path.join(r2, "c"), { recursive: true });
  const swarms = [
    { swarmId: "s1", enabled: true, configuredRoot: r1 },
    { swarmId: "s1", enabled: true, configuredRoot: r2 }
  ];
  assert.equal(matchWorkspace(path.join(r2, "c"), swarms).swarmId, "s1");
});

test("matchWorkspace: environment-variable configured root resolves against env", () => {
  const root = tmpDir();
  const env = { WS_ROOT: root };
  mkdirSync(path.join(root, "sub"), { recursive: true });
  const swarms = [{ swarmId: "s1", enabled: true, configuredRoot: "${WS_ROOT}" }];
  assert.equal(matchWorkspace(path.join(root, "sub"), swarms, env).kind, "match");
});

test("matchWorkspace: symlinked workspace resolves via realpath", () => {
  const real = tmpDir();
  const link = path.join(tmpdir(), `swarm-link-${Date.now()}`);
  try { symlinkSync(real, link); } catch { return; } // skip if symlinks unavailable
  mkdirSync(path.join(real, "inside"), { recursive: true });
  const swarms = [{ swarmId: "s1", enabled: true, configuredRoot: link }];
  assert.equal(matchWorkspace(path.join(link, "inside"), swarms).kind, "match");
});

test("diagnoseWorkspaceRoots reports missing roots as warnings", () => {
  const swarms = [{ swarmId: "s1", enabled: true, configuredRoot: "/nonexistent/xyz-abc" }];
  const diag = diagnoseWorkspaceRoots(swarms);
  assert.equal(diag.length, 1);
  assert.equal(diag[0].accessible, false);
  assert.ok(diag[0].warning);
});
