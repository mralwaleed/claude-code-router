import assert from "node:assert/strict";
import test from "node:test";
import { loadPersistedAppConfig } from "../../packages/core/src/config/app-config-store.ts";
import { loadAppConfig, parseProvidersForTest, saveAppConfig } from "../../packages/core/src/config/config.ts";
import { normalizedProviderCapabilitiesForTest } from "../../packages/core/src/gateway/service.ts";
import { cliproxyProviderAccountConfig } from "../../packages/core/src/providers/account-service.ts";

// Regression scenario reported live: a custom provider saved with a manual
// anthropic_messages override while auto-detection stored gemini_interactions.
// Before the fix, every config load stripped `protocolMode`, so the manual lock
// was lost and the gateway reverted to `provider-2::gemini_interactions`.
const regressionProvider = {
  id: "provider-2",
  name: "provider-2",
  api_base_url: "http://127.0.0.1:8317/v1",
  api_key: "ccr-local-secret",
  models: ["gpt-5.6-sol"],
  type: "anthropic_messages",
  protocolMode: "manual",
  // Auto-detection stored this competing capability; it must never win over the
  // manual runtime protocol.
  capabilities: [
    { baseUrl: "http://127.0.0.1:8317/v1", source: "detected", type: "gemini_interactions" }
  ]
};

test("parseProviders preserves manual protocolMode through a disk round-trip", () => {
  const parsed = parseProvidersForTest([regressionProvider]);

  assert.ok(parsed, "parseProviders returned a list");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].protocolMode, "manual");
  assert.equal(parsed[0].type, "anthropic_messages");
});

test("parseProviders preserves the detected gemini_interactions capability alongside the manual lock", () => {
  const parsed = parseProvidersForTest([regressionProvider]);

  assert.deepEqual(
    parsed[0].capabilities?.map((capability) => capability.type),
    ["gemini_interactions"]
  );
});

test("parseProviders treats missing/garbage protocolMode as undefined and preserves explicit auto", () => {
  const parsed = parseProvidersForTest([
    { name: "p1", id: "provider-2", type: "anthropic_messages" },
    { name: "p2", id: "provider-3", type: "openai_chat_completions", protocolMode: "auto" },
    { name: "p3", id: "provider-4", type: "openai_chat_completions", protocolMode: "weird" }
  ]);

  assert.equal(parsed[0].protocolMode, undefined, "absent -> undefined (auto is the default)");
  assert.equal(parsed[1].protocolMode, "auto", "explicit auto preserved verbatim");
  assert.equal(parsed[2].protocolMode, undefined, "garbage sanitized to undefined");
});

test("manual anthropic protocol survives a save -> load round-trip (restart / config reload)", async () => {
  const base = await loadAppConfig();
  await saveAppConfig({ ...base, Providers: [regressionProvider] });

  // Inspect the RAW on-disk config.sqlite content (before parseProviders runs)
  // to prove the manual override is literally persisted, not just re-derived.
  const raw = await loadPersistedAppConfig();
  const rawProvider = raw.Providers.find((item) => item.id === "provider-2");
  assert.ok(rawProvider, "provider-2 present in raw config.sqlite");
  assert.equal(rawProvider.protocolMode, "manual");
  assert.equal(rawProvider.type, "anthropic_messages");

  const reloaded = await loadAppConfig();
  const provider = reloaded.Providers.find((item) => item.id === "provider-2");

  assert.ok(provider, "provider-2 present after reload");
  assert.equal(provider.protocolMode, "manual");
  assert.equal(provider.type, "anthropic_messages");
});

test("reloaded manual provider locks the gateway to anthropic_messages (no gemini_interactions regression)", async () => {
  const base = await loadAppConfig();
  await saveAppConfig({ ...base, Providers: [regressionProvider] });

  const reloaded = await loadAppConfig();
  const provider = reloaded.Providers.find((item) => item.id === "provider-2");

  // The detected gemini_interactions capability is still present on disk, but the
  // manual lock must collapse the runtime capabilities to anthropic_messages, so
  // the gateway emits `provider-2::anthropic_messages` / type anthropic_messages.
  assert.ok(
    provider.capabilities?.some((capability) => capability.type === "gemini_interactions"),
    "detected gemini_interactions capability still stored"
  );

  const capabilities = normalizedProviderCapabilitiesForTest(provider);
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].type, "anthropic_messages");
  assert.notEqual(capabilities[0].type, "gemini_interactions");

  // The gateway entry name/type are derived from the locked capability and the
  // provider id (providerRuntimeId), so the generated config resolves to
  // provider-2::anthropic_messages / type anthropic_messages — never gemini.
  assert.equal(`${provider.id}::${capabilities[0].type}`, "provider-2::anthropic_messages");
});

test("editing the cliproxy usage connector does not reset protocolMode or type", async () => {
  const base = await loadAppConfig();
  await saveAppConfig({ ...base, Providers: [regressionProvider] });
  let reloaded = await loadAppConfig();
  let provider = reloaded.Providers.find((item) => item.id === "provider-2");

  // Simulate reopening the editor, attaching a native cliproxy usage connector
  // (an unrelated-field edit), and saving again.
  const withConnector = {
    ...provider,
    account: cliproxyProviderAccountConfig("codex:account_a1b2c3d4e5f6")
  };
  await saveAppConfig({ ...reloaded, Providers: [withConnector] });

  reloaded = await loadAppConfig();
  provider = reloaded.Providers.find((item) => item.id === "provider-2");

  assert.equal(provider.protocolMode, "manual", "protocolMode preserved across usage-connector edit");
  assert.equal(provider.type, "anthropic_messages", "type preserved across usage-connector edit");
  assert.equal(provider.account?.enabled, true);
  assert.equal(provider.account?.connectors?.[0]?.type, "cliproxy");
});

test("gateway stays locked to anthropic_messages after the usage-connector edit and reload", async () => {
  const reloaded = await loadAppConfig();
  const provider = reloaded.Providers.find((item) => item.id === "provider-2");

  const capabilities = normalizedProviderCapabilitiesForTest(provider);
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].type, "anthropic_messages");
});
