import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  cliproxyConnectorForTest,
  cliproxyProviderAccountConfig,
  cliproxyUsageMetersForTest,
  listCliProxyProviders
} from "../../packages/core/src/providers/account-service.ts";

// Representative CLIProxyAPI normalized usage payload (shape from the
// provider-scoped usage contract). No real account id, token, or email.
const sampleUsagePayload = {
  provider: {
    id: "codex:account_a1b2c3d4e5f6",
    type: "codex",
    displayName: "ChatGPT Plus · a***@example.com"
  },
  status: "ok",
  message: "5h: 78% remaining | weekly: 60% remaining | plan: plus",
  fetchedAt: "2026-07-13T00:00:00.000Z",
  meters: [
    {
      id: "primary",
      kind: "rate_limit",
      label: "5-hour usage window",
      used: 22,
      remaining: 78,
      limit: 100,
      unit: "%",
      window: "5h",
      resetAt: "2026-07-13T05:00:00.000Z"
    },
    {
      id: "secondary",
      kind: "rate_limit",
      label: "Weekly usage window",
      used: 40,
      remaining: 60,
      limit: 100,
      unit: "%",
      window: "weekly",
      resetAt: "2026-07-21T00:00:00.000Z"
    }
  ],
  balance: { remaining: 78, used: 22, total: 100 },
  subscription: { remaining: 60, limit: 100, resetAt: "2026-07-21T00:00:00.000Z" }
};

// Representative normalized Claude (Anthropic) usage payload produced by the
// CLIProxyAPI Claude adapter. Rolling windows use a 0-100 used/remaining scale
// (utilization 0.0 -> 0% used / 100% remaining); a scoped "limits" entry
// (Fable) and the extra-usage credits meter are preserved. No real account id,
// token, or email.
const sampleClaudeUsagePayload = {
  provider: {
    id: "claude:account_493276b6ec2c",
    type: "claude",
    displayName: "Claude Max · c***@example.com"
  },
  status: "ok",
  message: "5h: 75% remaining | 7d: 100% remaining | plan: max",
  fetchedAt: "2026-07-13T00:00:00.000Z",
  meters: [
    { id: "five_hour", kind: "rate_limit", label: "5-hour usage window", used: 25, remaining: 75, limit: 100, unit: "%", window: "5h", resetAt: "2026-07-13T05:00:00.000Z" },
    { id: "seven_day", kind: "rate_limit", label: "7-day usage window", used: 0, remaining: 100, limit: 100, unit: "%", window: "weekly", resetAt: "2026-07-20T00:00:00.000Z" },
    { id: "seven_day_opus", kind: "rate_limit", label: "7-day Opus", used: 50, remaining: 50, limit: 100, unit: "%", window: "weekly", resetAt: "2026-07-20T00:00:00.000Z" },
    { id: "weekly_scoped-claude-fable-5", kind: "rate_limit", label: "Weekly scoped limit · claude-fable-5", used: 30, remaining: 70, limit: 100, unit: "%", window: "weekly", resetAt: "2026-07-20T00:00:00.000Z" },
    { id: "extra_usage", kind: "request_limit", label: "Extra usage (monthly)", used: 25, remaining: 75, limit: 100, unit: "credits", window: "monthly" }
  ],
  balance: { remaining: 75, used: 25, total: 100 },
  subscription: { remaining: 100, limit: 100, resetAt: "2026-07-20T00:00:00.000Z" }
};

function withMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("cliproxyUsageMetersForTest maps CLIProxyAPI meters to account meters", () => {
  const meters = cliproxyUsageMetersForTest(sampleUsagePayload);
  assert.equal(meters.length, 2);

  const primary = meters.find((meter) => meter.id === "primary");
  assert.ok(primary, "primary meter present");
  assert.equal(primary.remaining, 78);
  assert.equal(primary.limit, 100);
  assert.equal(primary.unit, "%");
  assert.equal(primary.window, "5h");
  assert.equal(primary.resetAt, "2026-07-13T05:00:00.000Z");
  assert.equal(primary.source, "cliproxy");

  const secondary = meters.find((meter) => meter.id === "secondary");
  assert.ok(secondary, "secondary meter present");
  assert.equal(secondary.remaining, 60);
  assert.equal(secondary.window, "weekly");
});

test("cliproxyUsageMetersForTest ignores non-object or meterless payloads", () => {
  assert.deepEqual(cliproxyUsageMetersForTest(null), []);
  assert.deepEqual(cliproxyUsageMetersForTest({}), []);
  assert.deepEqual(cliproxyUsageMetersForTest({ meters: "not-an-array" }), []);
});

test("cliproxyUsageMetersForTest accepts a normalized Claude payload (five_hour / seven_day / scoped / extra_usage)", () => {
  const meters = cliproxyUsageMetersForTest(sampleClaudeUsagePayload);
  assert.ok(meters.length >= 4, `expected >=4 meters, got ${meters.length}`);

  const fiveHour = meters.find((meter) => meter.id === "five_hour");
  assert.ok(fiveHour, "five_hour meter present");
  assert.equal(fiveHour.remaining, 75);
  assert.equal(fiveHour.limit, 100);
  assert.equal(fiveHour.unit, "%");
  assert.equal(fiveHour.window, "5h");
  assert.equal(fiveHour.source, "cliproxy");

  // zero utilization -> 0% used / 100% remaining
  const sevenDay = meters.find((meter) => meter.id === "seven_day");
  assert.ok(sevenDay, "seven_day meter present");
  assert.equal(sevenDay.remaining, 100);

  // scoped Fable limit (percent already on a 0-100 scale) is preserved
  const fable = meters.find((meter) => meter.id === "weekly_scoped-claude-fable-5");
  assert.ok(fable, "fable scoped meter present");
  assert.equal(fable.remaining, 70);

  // extra-usage credits meter is preserved
  const extra = meters.find((meter) => meter.id === "extra_usage");
  assert.ok(extra, "extra_usage meter present");
  assert.equal(extra.unit, "credits");
});

test("cliproxyProviderAccountConfig builds a cliproxy connector with the providerId", () => {
  const account = cliproxyProviderAccountConfig("codex:account_a1b2c3d4e5f6");
  assert.equal(account.enabled, true);
  assert.equal(account.connectors.length, 1);
  const connector = account.connectors[0];
  assert.equal(connector.type, "cliproxy");
  assert.equal(connector.providerId, "codex:account_a1b2c3d4e5f6");
  assert.equal(connector.auth, "provider-api-key");
});

test("cliproxyProviderAccountConfig throws when the providerId is empty", () => {
  assert.throws(() => cliproxyProviderAccountConfig("  "), /providerId/i);
});

test("listCliProxyProviders calls /v0/management/providers with the management key and strips the /v1 suffix", async () => {
  let receivedPath = null;
  let receivedAuth = null;
  let receivedManagementKey = null;
  const server = await withMockServer((req, res) => {
    receivedPath = req.url;
    receivedAuth = req.headers.authorization;
    receivedManagementKey = req.headers["x-management-key"];
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        providers: [
          {
            id: "codex:account_a1b2c3d4e5f6",
            type: "codex",
            displayName: "ChatGPT Plus · a***@example.com",
            usageSupported: true,
            status: "active"
          },
          {
            id: "gemini:key_0123456789ab",
            type: "gemini",
            displayName: "Gemini (API key)",
            usageSupported: false,
            status: "active"
          }
        ]
      })
    );
  });
  const port = server.address().port;

  try {
    const result = await listCliProxyProviders({
      // The provider api_base_url carries a trailing /v1; the management base
      // is the origin, so /v1 must be stripped.
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-mgmt-key"
    });

    assert.equal(receivedPath, "/v0/management/providers");
    assert.equal(receivedAuth, "Bearer test-mgmt-key");
    assert.equal(receivedManagementKey, "test-mgmt-key");
    assert.equal(result.endpoint, `http://127.0.0.1:${port}`);
    assert.equal(result.providers.length, 2);

    const codex = result.providers.find((provider) => provider.type === "codex");
    assert.ok(codex);
    assert.equal(codex.id, "codex:account_a1b2c3d4e5f6");
    assert.equal(codex.usageSupported, true);
    assert.equal(codex.status, "active");

    const gemini = result.providers.find((provider) => provider.type === "gemini");
    assert.equal(gemini.usageSupported, false);
  } finally {
    await closeServer(server);
  }
});

test("cliproxyConnectorForTest fetches the provider-scoped usage URL, URL-encodes the providerId, and reuses the provider api_key", async () => {
  let receivedPath = null;
  let receivedAuth = null;
  let receivedManagementKey = null;
  const server = await withMockServer((req, res) => {
    receivedPath = req.url;
    receivedAuth = req.headers.authorization;
    receivedManagementKey = req.headers["x-management-key"];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(sampleUsagePayload));
  });
  const port = server.address().port;

  try {
    const provider = {
      name: "provider-2",
      api_base_url: `http://127.0.0.1:${port}/v1`,
      api_key: "ccr-local-secret",
      models: []
    };
    const connector = {
      type: "cliproxy",
      providerId: "codex:account_a1b2c3d4e5f6",
      auth: "provider-api-key"
    };

    const result = await cliproxyConnectorForTest(provider, connector);

    // The colon in the stable provider id is URL-encoded in the path.
    assert.equal(receivedPath, "/v0/management/providers/codex%3Aaccount_a1b2c3d4e5f6/usage");
    // The provider api_key is reused as the CLIProxyAPI management key.
    assert.equal(receivedAuth, "Bearer ccr-local-secret");
    assert.equal(receivedManagementKey, "ccr-local-secret");

    assert.equal(result.source, "cliproxy");
    assert.equal(result.meters.length, 2);
    const primary = result.meters.find((meter) => meter.id === "primary");
    assert.ok(primary);
    assert.equal(primary.remaining, 78);
    assert.equal(primary.limit, 100);
    assert.equal(primary.source, "cliproxy");
  } finally {
    await closeServer(server);
  }
});

test("cliproxyConnectorForTest appends ?refresh=1 when refresh is set", async () => {
  let receivedPath = null;
  const server = await withMockServer((req, res) => {
    receivedPath = req.url;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(sampleUsagePayload));
  });
  const port = server.address().port;

  try {
    const provider = { name: "provider-2", api_base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", models: [] };
    const connector = { type: "cliproxy", providerId: "codex:account_a1b2c3d4e5f6", refresh: true };
    await cliproxyConnectorForTest(provider, connector);
    assert.equal(receivedPath, "/v0/management/providers/codex%3Aaccount_a1b2c3d4e5f6/usage?refresh=1");
  } finally {
    await closeServer(server);
  }
});

test("cliproxyConnectorForTest surfaces an upstream non-200 as a connector error", async () => {
  const server = await withMockServer((req, res) => {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "error", code: "USAGE_UNAUTHORIZED", message: "Credential unauthorized" }));
  });
  const port = server.address().port;

  try {
    const provider = { name: "provider-2", api_base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", models: [] };
    const connector = { type: "cliproxy", providerId: "codex:account_a1b2c3d4e5f6" };
    const result = await cliproxyConnectorForTest(provider, connector);
    assert.equal(result.meters.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].source, "cliproxy");
    assert.match(result.errors[0].message, /403/);
  } finally {
    await closeServer(server);
  }
});

test("cliproxyConnectorForTest returns an error when the providerId is missing", async () => {
  const provider = { name: "provider-2", api_base_url: "http://127.0.0.1:1/v1", api_key: "k", models: [] };
  const result = await cliproxyConnectorForTest(provider, { type: "cliproxy", providerId: "  " });
  assert.equal(result.meters.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /providerId/i);
});
