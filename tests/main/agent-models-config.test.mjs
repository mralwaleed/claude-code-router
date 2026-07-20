import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentModelsForTest } from "../../packages/core/src/config/config.ts";

test("parseAgentModels parses a slug -> selector map", () => {
  const result = parseAgentModelsForTest({
    "team-leader": "Claude Proxy/claude-fable-5",
    worker: "Z.ai (Global) - Coding Plan/glm-5.2"
  });
  assert.deepEqual(result, {
    "team-leader": "Claude Proxy/claude-fable-5",
    worker: "Z.ai (Global) - Coding Plan/glm-5.2"
  });
});

test("parseAgentModels trims keys and values and drops empty ones", () => {
  const result = parseAgentModelsForTest({
    "  reviewer  ": "  ChatGPT Plus/gpt-5.6-sol  ",
    "empty-value": "   ",
    "": "Provider/model",
    "empty-key": ""
  });
  assert.deepEqual(result, {
    reviewer: "ChatGPT Plus/gpt-5.6-sol"
  });
});

test("parseAgentModels ignores non-string values", () => {
  const result = parseAgentModelsForTest({
    worker: "Provider/glm",
    nested: { model: "x" },
    list: ["a", "b"],
    number: 3
  });
  assert.deepEqual(result, { worker: "Provider/glm" });
});

test("parseAgentModels returns undefined for non-object or empty input", () => {
  assert.equal(parseAgentModelsForTest(undefined), undefined);
  assert.equal(parseAgentModelsForTest(null), undefined);
  assert.equal(parseAgentModelsForTest("not-an-object"), undefined);
  assert.equal(parseAgentModelsForTest([]), undefined);
  assert.equal(parseAgentModelsForTest({}), undefined);
});
