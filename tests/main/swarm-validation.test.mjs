import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalizeText, sha256Hex } from "../../packages/core/src/swarm/canonicalize.ts";
import {
  applyCollisionStatus,
  detectFingerprintCollisions,
  providerViewsFromConfig,
  resolveAssignment,
  validateSwarmProfile
} from "../../packages/core/src/swarm/validation.ts";
const FIXT = path.join(__dirname, "..", "..", "..", "tests", "fixtures", "swarm");

const PROVIDERS = providerViewsFromConfig([
  { id: "prov-alpha", name: "AlphaProvider", models: ["alpha-model"] },
  { id: "prov-beta", name: "BetaProvider", models: ["beta-model", "beta-fast"] },
  { name: "Gamma", models: ["gamma-model"] } // no id -> id falls back to name
]);

test("providerViewsFromConfig: id falls back to name", () => {
  const gamma = PROVIDERS.find((p) => p.name === "Gamma");
  assert.equal(gamma?.id, "Gamma");
});

test("resolveAssignment resolves by providerId + validates membership", () => {
  const r = resolveAssignment({ providerId: "prov-alpha", model: "alpha-model" }, PROVIDERS);
  assert.equal(r.ok, true);
  assert.equal(r.providerId, "prov-alpha");
  assert.equal(r.model, "alpha-model");
});

test("resolveAssignment resolves by display providerName", () => {
  const r = resolveAssignment({ providerName: "BetaProvider", model: "beta-model" }, PROVIDERS);
  assert.equal(r.ok, true);
  assert.equal(r.providerId, "prov-beta");
});

test("resolveAssignment rejects unknown provider", () => {
  const r = resolveAssignment({ providerId: "nope", model: "alpha-model" }, PROVIDERS);
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(" ").includes("provider not found"));
});

test("resolveAssignment rejects model not under provider (no silent cross-provider routing)", () => {
  const r = resolveAssignment({ providerId: "prov-alpha", model: "beta-model" }, PROVIDERS);
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(" ").includes("not registered"));
});

test("resolveAssignment rejects empty model", () => {
  const r = resolveAssignment({ providerId: "prov-alpha", model: "" }, PROVIDERS);
  assert.equal(r.ok, false);
});

function baseProfile(overrides = {}) {
  return {
    id: "sw1",
    schemaVersion: 1,
    name: "Test",
    description: "",
    enabled: true,
    workspaceRoots: ["/tmp/ws"],
    launchDirectory: "/tmp/ws",
    mainInstructionFile: "",
    agentDirectories: [],
    leaderProviderId: "prov-alpha",
    leaderModel: "alpha-model",
    defaultProviderId: "prov-beta",
    defaultModel: "beta-model",
    fallbackProviderId: "",
    fallbackModel: "",
    routingMode: "exact",
    autoDetectWorkspace: false,
    watchFiles: true,
    createdAt: "t",
    updatedAt: "t",
    ...overrides
  };
}

test("validateSwarmProfile ok for a valid profile", () => {
  const v = validateSwarmProfile(baseProfile(), PROVIDERS);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test("validateSwarmProfile fails when leader model is unknown", () => {
  const v = validateSwarmProfile(baseProfile({ leaderModel: "ghost" }), PROVIDERS);
  assert.equal(v.ok, false);
  assert.ok(v.errors.join(" ").includes("leader assignment invalid"));
});

test("validateSwarmProfile fails when default provider missing", () => {
  const v = validateSwarmProfile(baseProfile({ defaultProviderId: "missing" }), PROVIDERS);
  assert.equal(v.ok, false);
  assert.ok(v.errors.join(" ").includes("default assignment invalid"));
});

test("validateSwarmProfile warns (not fails) on optional fallback invalid", () => {
  const v = validateSwarmProfile(baseProfile({ fallbackProviderId: "prov-alpha", fallbackModel: "wrong" }), PROVIDERS);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.join(" ").includes("fallback"));
});

test("validateSwarmProfile fails on empty name / no workspace roots", () => {
  const v = validateSwarmProfile(baseProfile({ name: "", workspaceRoots: [] }), PROVIDERS);
  assert.equal(v.ok, false);
  assert.ok(v.errors.join(" ").includes("name"));
  assert.ok(v.errors.join(" ").includes("workspace root"));
});

// ---- collision detection (uses synthetic agent fixtures) ----

function agentBodyHash(file) {
  const raw = fs.readFileSync(path.join(FIXT, "agents", file), "utf8");
  const body = raw.split("\n---\n").slice(1).join("\n---\n");
  return sha256Hex(canonicalizeText(body));
}

test("detectFingerprintCollisions flags identical bodies only", () => {
  const alpha = agentBodyHash("alpha.md");
  const beta = agentBodyHash("beta.md");
  const dupA = agentBodyHash("dup-a.md");
  const dupB = agentBodyHash("dup-b.md");
  assert.equal(dupA, dupB, "dup-a and dup-b fixtures must share a body");
  assert.notEqual(alpha, beta);

  const collisions = detectFingerprintCollisions([
    { id: "alpha", bodyHash: alpha, enabled: true },
    { id: "beta", bodyHash: beta, enabled: true },
    { id: "dup-a", bodyHash: dupA, enabled: true },
    { id: "dup-b", bodyHash: dupB, enabled: true }
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].agentIds.sort(), ["dup-a", "dup-b"]);
});

test("detectFingerprintCollisions ignores disabled agents", () => {
  const dupA = agentBodyHash("dup-a.md");
  const collisions = detectFingerprintCollisions([
    { id: "dup-a", bodyHash: dupA, enabled: true },
    { id: "dup-b", bodyHash: dupA, enabled: false }
  ]);
  assert.equal(collisions.length, 0);
});

test("applyCollisionStatus marks colliding agents", () => {
  const dupA = agentBodyHash("dup-a.md");
  const agents = [
    { id: "alpha", bodyHash: agentBodyHash("alpha.md"), validationStatus: "ok", validationErrors: [] },
    { id: "dup-a", bodyHash: dupA, validationStatus: "ok", validationErrors: [] },
    { id: "dup-b", bodyHash: dupA, validationStatus: "ok", validationErrors: [] }
  ].map((a) => ({ ...a, swarmId: "sw1", slug: a.id, displayName: a.id, sourceFile: "", providerOverrideId: "", modelOverride: "", enabled: true, capabilities: [], distinctiveHash: "", assignmentSource: "frontmatter", lastLoadedAt: "", lastModifiedAt: "" }));
  const collisions = detectFingerprintCollisions(agents);
  const marked = applyCollisionStatus(agents, collisions);
  const dupB = marked.find((a) => a.id === "dup-b");
  const alpha = marked.find((a) => a.id === "alpha");
  assert.equal(dupB?.validationStatus, "collides");
  assert.ok(dupB?.validationErrors.join(" ").includes("dup-a"));
  assert.equal(alpha?.validationStatus, "ok");
});
