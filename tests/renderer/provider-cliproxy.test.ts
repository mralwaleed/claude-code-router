import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderAccountDraftFromConfig,
  createProviderDraft,
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
