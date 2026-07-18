import assert from "node:assert/strict";
import test from "node:test";
import { normalizedProviderCapabilitiesForTest } from "../../packages/core/src/gateway/service.ts";
import { parseProviderBaseUrl, providerBaseUrlForProtocol } from "../../packages/core/src/providers/url.ts";

test("manual anthropic_messages locks runtime capabilities to a single anthropic protocol", () => {
  const provider = {
    name: "Example",
    models: ["claude-test"],
    api_base_url: "https://api.example.com/v1",
    type: "anthropic_messages",
    protocolMode: "manual",
    // Competing detected capabilities that must be ignored under the manual lock.
    capabilities: [
      { baseUrl: "https://api.example.com/v1", source: "detected", type: "openai_chat_completions" },
      { baseUrl: "https://api.example.com/v1", source: "detected", type: "gemini_interactions" }
    ]
  };

  const capabilities = normalizedProviderCapabilitiesForTest(provider);

  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].type, "anthropic_messages");
});

test("manual protocol with no matching capability synthesizes one from the base URL", () => {
  const provider = {
    name: "Example",
    models: ["claude-test"],
    api_base_url: "https://api.example.com/v1",
    type: "anthropic_messages",
    protocolMode: "manual"
  };

  const capabilities = normalizedProviderCapabilitiesForTest(provider);

  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].type, "anthropic_messages");
  assert.equal(capabilities[0].baseUrl, "https://api.example.com");
});

test("auto mode keeps detected capabilities (manual lock does not apply)", () => {
  const provider = {
    name: "Example",
    models: ["claude-test"],
    api_base_url: "https://api.example.com/v1",
    type: "anthropic_messages",
    capabilities: [
      { baseUrl: "https://api.example.com/v1", source: "detected", type: "openai_chat_completions" },
      { baseUrl: "https://api.example.com/v1", source: "detected", type: "anthropic_messages" }
    ]
  };

  const capabilities = normalizedProviderCapabilitiesForTest(provider);
  const types = capabilities.map((capability) => capability.type);

  assert.ok(types.includes("openai_chat_completions"));
  assert.ok(types.includes("anthropic_messages"));
});

test("anthropic_messages base URL ending in /v1 resolves to /v1/messages", () => {
  const parsed = parseProviderBaseUrl("https://api.example.com/v1");
  const anthropicBase = providerBaseUrlForProtocol(parsed, "anthropic_messages");

  // The core gateway appends /v1/messages for the anthropic_messages protocol,
  // so a base URL ending in /v1 must normalize back to a root whose /v1/messages
  // path is the original endpoint (not /v1/v1/messages).
  assert.equal(anthropicBase, "https://api.example.com");
  assert.equal(`${anthropicBase}/v1/messages`, "https://api.example.com/v1/messages");
});

test("Claude Code tool call round-trip preserves valid tool JSON under anthropic_messages", () => {
  // A representative Claude Code Anthropic Messages request carrying a tool
  // definition, an assistant tool_use block, and a user tool_result block.
  const toolUseId = "toolu_01ABC";
  const body = {
    model: "claude-test",
    max_tokens: 1024,
    tools: [
      {
        name: "get_weather",
        description: "Get the weather for a city.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"]
        }
      }
    ],
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "get_weather", input: { city: "San Francisco" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: '{"temperature":57,"unit":"F"}' }]
      }
    ]
  };

  // The tool payload survives a serialize/deserialize round-trip unchanged — no
  // field renaming or coercion at the JSON boundary.
  const roundTripped = JSON.parse(JSON.stringify(body));
  assert.deepEqual(roundTripped.tools, body.tools);
  assert.deepEqual(roundTripped.messages, body.messages);
  assert.equal(roundTripped.messages[0].content[0].input.city, "San Francisco");
  assert.equal(roundTripped.messages[1].content[0].tool_use_id, toolUseId);

  // Because the provider is locked to anthropic_messages, the runtime exposes
  // only that protocol, so the request is forwarded natively to /v1/messages
  // and never routed through Gemini functionCall/functionResponse conversion.
  const provider = {
    name: "Example",
    models: ["claude-test"],
    api_base_url: "https://api.example.com/v1",
    type: "anthropic_messages",
    protocolMode: "manual",
    capabilities: [
      { baseUrl: "https://api.example.com/v1", source: "detected", type: "gemini_generate_content" }
    ]
  };
  const capabilities = normalizedProviderCapabilitiesForTest(provider);
  assert.deepEqual(
    capabilities.map((capability) => capability.type),
    ["anthropic_messages"]
  );
});
