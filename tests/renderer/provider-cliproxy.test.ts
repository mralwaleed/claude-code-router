import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayProviderConfig } from "@ccr/core/contracts/app";
import {
  createProviderAccountDraftFromConfig,
  createProviderDraft,
  createProviderDraftFromProvider,
  parseProviderAccountDraft,
  providerCliproxyConnectorFromDraft
} from "../../packages/ui/src/pages/home/shared/index.tsx";
import { installBrowserGlobals } from "./fixtures.ts";

installBrowserGlobals();

type CliproxyConnector = {
  type?: string;
  providerId?: string;
  endpoint?: string;
  managementKey?: string;
  refresh?: boolean;
};

test("cliproxy account connector round-trips through the draft model", () => {
  const account = {
    enabled: true,
    connectors: [
      {
        type: "cliproxy",
        providerId: "codex:account_a1b2c3d4e5f6",
        auth: "provider-api-key",
        endpoint: "http://127.0.0.1:8317",
        managementKey: "override-key",
        refresh: true
      }
    ]
  };

  const draft = {
    ...createProviderDraft([]),
    ...createProviderAccountDraftFromConfig(account)
  };

  assert.equal(draft.accountMode, "cliproxy");
  assert.equal(draft.cliproxyProviderId, "codex:account_a1b2c3d4e5f6");
  assert.equal(draft.cliproxyEndpoint, "http://127.0.0.1:8317");
  assert.equal(draft.cliproxyManagementKey, "override-key");
  assert.equal(draft.cliproxyRefresh, true);

  const parsed = parseProviderAccountDraft(draft);
  assert.equal(typeof parsed, "object");
  const restored = parsed as unknown as { connectors?: CliproxyConnector[] };
  const connector = restored.connectors?.[0];
  assert.ok(connector, "connector restored");
  assert.equal(connector.type, "cliproxy");
  assert.equal(connector.providerId, "codex:account_a1b2c3d4e5f6");
  assert.equal(connector.endpoint, "http://127.0.0.1:8317");
  assert.equal(connector.managementKey, "override-key");
  assert.equal(connector.refresh, true);
});

test("cliproxy draft omits optional fields when they are unset", () => {
  const account = {
    enabled: true,
    connectors: [{ type: "cliproxy", providerId: "codex:account_a1b2c3d4e5f6", auth: "provider-api-key" }]
  };
  const draft = { ...createProviderDraft([]), ...createProviderAccountDraftFromConfig(account) };
  const connector = providerCliproxyConnectorFromDraft(draft) as unknown as CliproxyConnector;

  assert.equal(connector.type, "cliproxy");
  assert.equal(connector.providerId, "codex:account_a1b2c3d4e5f6");
  assert.equal("endpoint" in connector, false);
  assert.equal("managementKey" in connector, false);
  assert.equal("refresh" in connector, false);
});

test("cliproxy draft requires a provider id", () => {
  const draft = {
    ...createProviderDraft([]),
    ...createProviderAccountDraftFromConfig(undefined),
    accountEnabled: true,
    accountMode: "cliproxy"
  };
  const result = parseProviderAccountDraft(draft);
  assert.equal(typeof result, "string");
  assert.match(result as string, /provider id/i);
});

test("disabled account yields no connectors", () => {
  const account = {
    enabled: true,
    connectors: [{ type: "cliproxy", providerId: "codex:account_a1b2c3d4e5f6", auth: "provider-api-key" }]
  };
  const draft = { ...createProviderDraft([]), ...createProviderAccountDraftFromConfig(account), accountEnabled: false };
  assert.equal(parseProviderAccountDraft(draft), undefined);
});

test("cliproxy save ignores a stale http-json usage URL and never reverts to http-json", () => {
  const draft = {
    ...createProviderDraft([]),
    accountEnabled: true,
    accountMode: "cliproxy",
    cliproxyProviderId: "codex:account_b2037260a35a",
    // leftover fields from the previous http-json connector that pointed at the :8321 bridge
    usageRequestUrl: "http://127.0.0.1:8321/usage",
    usageRequestMethod: "GET"
  };

  const parsed = parseProviderAccountDraft(draft);
  assert.equal(typeof parsed, "object");
  const restored = parsed as unknown as { connectors?: Array<{ type?: string; endpoint?: string; providerId?: string }> };
  const connectors = restored.connectors ?? [];

  assert.equal(connectors.length, 1, "exactly one connector");
  assert.equal(connectors[0]?.type, "cliproxy");
  assert.equal(connectors[0]?.providerId, "codex:account_b2037260a35a");
  assert.ok(!connectors.some((c) => c.type === "http-json"), "must not produce an http-json connector");
  assert.ok(
    !connectors.some((c) => (c.endpoint ?? "").includes("8321")),
    "must not reference the retired :8321 bridge"
  );
});

test("cliproxy account connector reopens in cliproxy mode and keeps a manual anthropic_messages protocol", () => {
  const provider = {
    id: "provider-2",
    name: "provider-2",
    api_base_url: "http://127.0.0.1:8317/v1",
    api_key: "test-provider-api-key",
    models: ["gpt-5.6-terra"],
    protocolMode: "manual",
    type: "anthropic_messages",
    account: {
      enabled: true,
      connectors: [
        {
          type: "cliproxy",
          providerId: "codex:account_b2037260a35a",
          auth: "provider-api-key",
          endpoint: "http://127.0.0.1:8317",
          managementKey: "separate-management-key",
          refresh: true
        }
      ]
    }
  } as unknown as GatewayProviderConfig;

  const draft = createProviderDraftFromProvider(provider);

  // usage connector reopens in cliproxy mode with every persisted field
  assert.equal(draft.accountMode, "cliproxy");
  assert.equal(draft.cliproxyProviderId, "codex:account_b2037260a35a");
  assert.equal(draft.cliproxyEndpoint, "http://127.0.0.1:8317");
  assert.equal(draft.cliproxyManagementKey, "separate-management-key");
  assert.equal(draft.cliproxyRefresh, true);

  // the manual Anthropic protocol override is independent of the usage connector
  assert.equal(draft.protocolMode, "manual");
  assert.equal(draft.protocol, "anthropic_messages");
  assert.equal(draft.modelsText, "gpt-5.6-terra");

  // saving again reproduces exactly the cliproxy connector (no http-json revert)
  const reparsed = parseProviderAccountDraft(draft);
  assert.equal(typeof reparsed, "object");
  const conn = (reparsed as unknown as {
    connectors?: Array<{ type?: string; providerId?: string; managementKey?: string }>;
  }).connectors?.[0];
  assert.equal(conn?.type, "cliproxy");
  assert.equal(conn?.providerId, "codex:account_b2037260a35a");
  assert.equal(conn?.managementKey, "separate-management-key");
});
