import assert from "node:assert/strict";
import test from "node:test";
import { createProviderDraftFromProvider } from "../../packages/ui/src/pages/home/shared/providers.ts";
import { installBrowserGlobals } from "./fixtures.ts";

installBrowserGlobals();

test("createProviderDraftFromProvider preserves a manual anthropic override when reopening the editor", () => {
  // The on-disk state of a cleanly-saved manual anthropic provider: the manual
  // protocol is locked and stored as its capability.
  const provider = {
    id: "provider-2",
    name: "provider-2",
    api_base_url: "http://127.0.0.1:8317/v1",
    api_key: "ccr-local-secret",
    models: ["gpt-5.6-sol"],
    type: "anthropic_messages",
    protocolMode: "manual",
    capabilities: [
      { baseUrl: "http://127.0.0.1:8317", source: "preset" as const, type: "anthropic_messages" as const }
    ]
  };

  const draft = createProviderDraftFromProvider(provider);

  assert.equal(draft.protocolMode, "manual");
  assert.equal(draft.protocol, "anthropic_messages");
  assert.deepEqual(draft.selectedProtocols, ["anthropic_messages"]);
});

test("createProviderDraftFromProvider keeps the manual anthropic protocol even when a gemini capability is detected", () => {
  // Adversarial on-disk state: auto-detection stored gemini_interactions but the
  // user locked anthropic_messages. Reopening the editor must still show Anthropic
  // Messages as the locked protocol.
  const provider = {
    id: "provider-2",
    name: "provider-2",
    api_base_url: "http://127.0.0.1:8317/v1",
    api_key: "ccr-local-secret",
    models: ["gpt-5.6-sol"],
    type: "anthropic_messages",
    protocolMode: "manual",
    capabilities: [
      { baseUrl: "http://127.0.0.1:8317/v1", source: "detected" as const, type: "gemini_interactions" as const }
    ]
  };

  const draft = createProviderDraftFromProvider(provider);

  assert.equal(draft.protocolMode, "manual");
  assert.equal(draft.protocol, "anthropic_messages");
  assert.notEqual(draft.protocol, "gemini_interactions");
});

test("createProviderDraftFromProvider defaults protocolMode to auto when the provider has no override", () => {
  const provider = {
    id: "provider-3",
    name: "provider-3",
    api_base_url: "http://127.0.0.1:8317/v1",
    api_key: "ccr-local-secret",
    models: ["gpt-5.6-sol"],
    type: "openai_chat_completions"
  };

  const draft = createProviderDraftFromProvider(provider);

  assert.equal(draft.protocolMode, "auto");
  assert.equal(draft.protocol, "openai_chat_completions");
});
