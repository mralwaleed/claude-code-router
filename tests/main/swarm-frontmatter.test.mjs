import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveAgentSlug,
  parseAgentFile,
  FRONTMATTER_MAX_CAPABILITIES,
  FRONTMATTER_MAX_NAME_LENGTH
} from "../../packages/core/src/swarm/frontmatter.ts";

test("parseAgentFile parses accepted frontmatter + body", () => {
  const content = `---
name: worker
description: Implements tasks.
provider: Z.ai (Global) - Coding Plan
providerId: prov-zai
model: glm-5.2
capabilities:
  - code
  - test
enabled: true
---
<CCR-AGENT-MODEL>prov-zai/glm-5.2</CCR-AGENT-MODEL>

# Worker

Does work.`;
  const parsed = parseAgentFile(content);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.name, "worker");
  assert.equal(parsed.frontmatter.providerId, "prov-zai");
  assert.equal(parsed.frontmatter.provider, "Z.ai (Global) - Coding Plan");
  assert.equal(parsed.frontmatter.model, "glm-5.2");
  assert.deepEqual(parsed.frontmatter.capabilities, ["code", "test"]);
  assert.equal(parsed.frontmatter.enabled, true);
  assert.ok(parsed.body.includes("# Worker"));
});

test("parseAgentFile works without frontmatter (pure body)", () => {
  const parsed = parseAgentFile("# Just a body\nno frontmatter");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.name, undefined);
  assert.ok(parsed.body.includes("Just a body"));
});

test("parseAgentFile rejects invalid YAML", () => {
  const parsed = parseAgentFile("---\nname: worker\n  bad: : :\n  : indent broken\n---\nbody");
  assert.ok(parsed.errors.length > 0);
  assert.match(parsed.errors.join(" "), /invalid YAML/i);
});

test("parseAgentFile rejects non-string name/provider/model", () => {
  const parsed = parseAgentFile("---\nname: 123\nprovider: true\nmodel: [a, b]\n---\nbody");
  const joined = parsed.errors.join(" ");
  assert.match(joined, /name.*string/i);
  assert.match(joined, /provider.*string/i);
  assert.match(joined, /model.*string/i);
});

test("parseAgentFile enforces max field length", () => {
  const longName = "x".repeat(FRONTMATTER_MAX_NAME_LENGTH + 1);
  const parsed = parseAgentFile(`---\nname: ${longName}\n---\nbody`);
  assert.match(parsed.errors.join(" "), /exceeds/i);
});

test("parseAgentFile rejects capabilities that are not an array of strings", () => {
  const parsed = parseAgentFile("---\ncapabilities: not-a-list\n---\nbody");
  assert.match(parsed.errors.join(" "), /capabilities.*array/i);
  const parsed2 = parseAgentFile("---\ncapabilities:\n  - ok\n  - 5\n---\nbody");
  assert.match(parsed2.errors.join(" "), /only strings/i);
});

test("parseAgentFile enforces max capabilities count", () => {
  const caps = Array.from({ length: FRONTMATTER_MAX_CAPABILITIES + 1 }, (_, i) => `c${i}`)
    .map((c) => `  - ${c}`)
    .join("\n");
  const parsed = parseAgentFile(`---\ncapabilities:\n${caps}\n---\nbody`);
  assert.match(parsed.errors.join(" "), /exceeds/i);
});

test("parseAgentFile detects duplicate top-level keys", () => {
  const parsed = parseAgentFile("---\nmodel: a\nmodel: b\n---\nbody");
  assert.match(parsed.errors.join(" "), /duplicate.*model/i);
});

test("parseAgentFile rejects non-boolean enabled", () => {
  const parsed = parseAgentFile("---\nenabled: yes-maybe\n---\nbody");
  assert.match(parsed.errors.join(" "), /enabled.*boolean/i);
});

test("parseAgentFile ignores unknown keys (forward-compatible)", () => {
  const parsed = parseAgentFile("---\nname: worker\nfutureThing: xyz\n---\nbody");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.name, "worker");
});

test("deriveAgentSlug uses frontmatter name, falls back to filename", () => {
  assert.equal(deriveAgentSlug("Backend Engineer", "backend.md"), "backend-engineer");
  assert.equal(deriveAgentSlug(undefined, "qa-cybersecurity-engineer.md"), "qa-cybersecurity-engineer");
});
