import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalizeSystem,
  canonicalizeText,
  extractDistinctiveSection,
  extractSystemText,
  sha256Hex
} from "../../packages/core/src/swarm/canonicalize.ts";

const FIXT = path.join(__dirname, "..", "..", "..", "tests", "fixtures", "swarm");

// ---- extractSystemText ----

test("extractSystemText: string passes through", () => {
  assert.equal(extractSystemText("hello"), "hello");
});

test("extractSystemText: array of text blocks joined in original order with \\n", () => {
  assert.equal(extractSystemText([{ type: "text", text: "first" }, { type: "text", text: "second" }]), "first\nsecond");
});

test("extractSystemText: ignores non-text blocks and non-string text", () => {
  const sys = [
    { type: "image", source: {} },
    { type: "text", text: 123 },
    { type: "text", text: "kept" },
    "raw-string-block"
  ];
  assert.equal(extractSystemText(sys), "kept\nraw-string-block");
});

// ---- canonicalizeText: frozen contract ----

test("canonicalizeText removes only recognized CCR routing markers", () => {
  const input = "<CCR-AGENT-MODEL>Provider/model</CCR-AGENT-MODEL> body <CCR-SUBAGENT-MODEL>x</CCR-SUBAGENT-MODEL> kept <CCR-AGENT>slug</CCR-AGENT> done";
  assert.equal(canonicalizeText(input), "body kept done");
});

test("canonicalizeText: marker removal does NOT concatenate adjacent words", () => {
  // marker surrounded by whitespace -> words stay separate (real agent files put markers on their own line)
  assert.equal(canonicalizeText("word1 <CCR-AGENT-MODEL>x</CCR-AGENT-MODEL> word2"), "word1 word2");
  assert.notEqual(canonicalizeText("word1 <CCR-AGENT-MODEL>x</CCR-AGENT-MODEL> word2"), "word1word2");
});

test("canonicalizeText collapses multiple spaces inside a sentence", () => {
  assert.equal(canonicalizeText("a    b     c"), "a b c");
});

test("canonicalizeText treats tabs and spaces equivalently", () => {
  assert.equal(canonicalizeText("a\t\tb"), "a b");
  assert.equal(canonicalizeText("a\tb"), canonicalizeText("a b"));
});

test("canonicalizeText treats newlines and spaces equivalently (whitespace-form agnostic)", () => {
  assert.equal(canonicalizeText("a\nb"), canonicalizeText("a b"));
  assert.equal(canonicalizeText("a\n\n\nb"), canonicalizeText("a b"));
});

test("canonicalizeText normalizes CRLF/CR to a single space", () => {
  assert.equal(canonicalizeText("a\r\nb\rc"), "a b c");
});

test("canonicalizeText collapses mixed Unicode whitespace (NBSP, en-space, etc.)", () => {
  //   = NBSP,   = en quad, 　 = ideographic space
  assert.equal(canonicalizeText("a  b c　d"), "a b c d");
});

test("canonicalizeText preserves case and punctuation, does not remove arbitrary text", () => {
  const input = "Keep CASE and Punctuation! Special <not-a-marker> stays. End.";
  assert.equal(canonicalizeText(input), "Keep CASE and Punctuation! Special <not-a-marker> stays. End.");
});

test("canonicalizeText trims leading/trailing whitespace", () => {
  assert.equal(canonicalizeText("   \n\n  hello  \n "), "hello");
});

test("canonicalizeText is idempotent", () => {
  const input = "<CCR-AGENT-MODEL>x</CCR-AGENT-MODEL>\r\n\r\nbody   with\ttabs";
  const once = canonicalizeText(input);
  assert.equal(canonicalizeText(once), once);
});

test("canonicalizeText handles multiple system text blocks via canonicalizeSystem", () => {
  const sys = [{ type: "text", text: "block one" }, { type: "text", text: "block\ttwo" }];
  // joined by \n then whitespace-collapsed -> single spaces
  assert.equal(canonicalizeSystem(sys), "block one block two");
});

// ---- string vs array system forms are canonicalization-equivalent ----

test("string and array system forms canonicalize identically (fixtures)", () => {
  const stringForm = JSON.parse(fs.readFileSync(path.join(FIXT, "requests", "system-string-form.json"), "utf8"));
  const arrayForm = JSON.parse(fs.readFileSync(path.join(FIXT, "requests", "system-array-form.json"), "utf8"));
  assert.equal(canonicalizeSystem(stringForm.system), canonicalizeSystem(arrayForm.system));
});

test("canonicalizeSystem handles string, array, and undefined", () => {
  assert.equal(canonicalizeSystem("hi\n"), "hi");
  assert.equal(canonicalizeSystem([{ type: "text", text: "hi" }]), "hi");
  assert.equal(canonicalizeSystem(undefined), "");
});

// ---- exact body containment with appended context (the v1 attribution primitive) ----

test("exact body containment holds when the system has prefix + appended context", () => {
  const body = canonicalizeText("You are an engineer.\n\n## Mission\nImplement tasks carefully.");
  const system = canonicalizeText(
    "You are a Claude agent.\n\n" + "You are an engineer.\n\n## Mission\nImplement tasks carefully.\n\n" +
      "<env>\nworking directory: /tmp\n</env>"
  );
  assert.equal(system.includes(body), true, "canonical body must be a substring of canonical system");
  // and a different body is NOT contained
  assert.equal(system.includes(canonicalizeText("You are a reviewer.")), false);
});

// ---- distinctive section (collapsed prefix; diagnostic index only) ----

test("extractDistinctiveSection anchors at the first markdown heading on collapsed text", () => {
  const body = canonicalizeText("intro line one\nintro line two\n# Heading\nline a\nline b\nline c");
  const section = extractDistinctiveSection(body, { maxLength: 12 });
  assert.ok(section.startsWith("# Heading"), `got: ${JSON.stringify(section)}`);
});

test("extractDistinctiveSection falls back to start when no heading", () => {
  const body = canonicalizeText("first\nsecond\nthird");
  assert.equal(extractDistinctiveSection(body, { maxLength: 5 }), "first");
});

// ---- sha256 ----

test("sha256Hex is deterministic", () => {
  assert.equal(sha256Hex("abc"), sha256Hex("abc"));
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(sha256Hex("abc"), sha256Hex("abd"));
});
