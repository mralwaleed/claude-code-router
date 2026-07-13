# CLIProxyAPI Provider-Scoped Usage — CCR Native Connector

This is the **Claude Code Router (consumer) side** of the provider-scoped usage
integration with [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It
replaces an external Python usage bridge (port 8321) with a native,
provider-scoped usage connector built into CCR's existing account/usage model.

> Counterpart: the **CLIProxyAPI (provider) side** — identity model, endpoints,
> request/response schema, authentication, error codes, caching, and the Codex
> adapter — is specified in
> [`docs/cliproxy-provider-usage-integration.md`](https://github.com/router-for-me/CLIProxyAPI/blob/main/docs/cliproxy-provider-usage-integration.md)
> in the CLIProxyAPI repository. This document covers only what CCR implements.

## 1. Goals

- Remove the external Python usage bridge (`~/.local/share/ccr-quota-adapter`,
  port 8321) that proxied a single hardcoded ChatGPT account.
- Display upstream quota for the **matching** provider/account in CCR's usage
  widget, resolved by a **stable provider ID**.
- Support multiple providers and multiple accounts (no hardcoded account).
- Preserve CCR's existing account/connector architecture — add a new connector
  source rather than a foreign field on `GatewayProviderConfig`.

Data flow:

```
CCR provider (account connector type "cliproxy")
  → CLIProxyAPI GET /v0/management/providers/{providerId}/usage
    → CLIProxyAPI resolves the matching OAuth credential by stable ID
      → upstream quota endpoint
        → normalized "meters" payload
          → CCR normalizeRemoteSnapshot → ProviderAccountMeter[]
            → CCR account/usage widget
```

## 2. The `cliproxy` account connector

Usage is modeled as a new account connector source, `"cliproxy"`, alongside the
existing `"standard" | "http-json" | "plugin" | "local-estimate" | "merged" |
"unsupported"` sources.

Contract (`packages/core/src/contracts/app.ts`):

```ts
export type ProviderAccountCliProxyConnectorConfig =
  ProviderAccountConnectorBaseConfig & {
    type: "cliproxy";
    providerId: string;        // stable CLIProxyAPI provider ID, e.g. "codex:account_a1b2c3d4e5f6"
    auth?: ProviderAccountAuthMode;
    endpoint?: string;         // CLIProxyAPI management base URL (origin). Defaults to the provider api_base_url origin.
    managementKey?: string;    // CLIProxyAPI management key. Defaults to the provider api_key.
    headers?: Record<string, string>;
    refresh?: boolean;         // append ?refresh=1 to bypass the upstream cache
  };
```

The connector is resolved by `account-service.ts::resolveConnector`, which
dispatches on `connector.type` to `resolveCliproxyConnector`.

## 3. How CCR resolves usage

`resolveCliproxyConnector` (in `packages/core/src/providers/account-service.ts`):

1. **Validates** that `connector.providerId` is non-empty.
2. **Resolves the management base URL** via `cliproxyManagementBaseUrl`:
   `connector.endpoint`, otherwise the origin of the provider's
   `api_base_url` (any `/v1`/path suffix is stripped to the origin). This lets a
   provider whose `api_base_url` is `http://127.0.0.1:8317/v1` reuse the same
   host for usage with no extra configuration.
3. **Resolves the management key** via `cliproxyManagementKey`:
   `connector.managementKey`, otherwise the provider's `api_key`. In a typical
   local setup the provider `api_key` and the CLIProxyAPI management password are
   the same value, so **no second secret needs to be stored**.
4. **Builds the request URL** via `cliproxyUsageUrl`:
   `${root}/v0/management/providers/${encodeURIComponent(providerId)}/usage`,
   appending `?refresh=1` when `connector.refresh` is set. The `providerId` is
   URL-encoded (the `:` is encoded as `%3A`), matching the server's decode.
5. **Sends auth headers** via `cliproxyRequestHeaders`: `Authorization: Bearer
   <key>` and `X-Management-Key: <key>`.
6. **Fetches** with `fetchWithSystemProxy` (which uses the global `fetch` for
   localhost, so it is mockable in tests), then `readJsonResponse` (throws on
   non-200).
7. **Normalizes** the payload with
   `normalizeRemoteSnapshot(provider.name, payload, "cliproxy")`, reading
   `payload.meters` into `ProviderAccountMeter[]`. A meter requires non-empty
   `id` + `label` + `unit`, and reads `limit` / `used` / `remaining` / `resetAt`
   / `kind` / `window` / `details`.

Because the response already carries the canonical `meters` array, CCR's generic
`normalizeRemoteSnapshot` / `normalizeMeter` path accepts it directly — no
cliproxy-specific parsing of `balance` / `subscription` is required.

## 4. Provider listing (UI picker)

A factory and listing helper live next to the resolver:

- `cliproxyProviderAccountConfig(providerId, options)` — builds a
  `ProviderAccountCliProxyConnectorConfig` (throws if `providerId` is empty).
- `listCliProxyProviders(request)` — `GET /v0/management/providers` and returns a
  `CliProxyProviderListResult` (`{ endpoint, providers: CliProxyProviderSummary[] }`),
  normalizing each entry to `{ id, type, displayName, status, usageSupported }`.

The listing is exposed to the renderer over a full IPC chain (6 layers, see
`packages/core/src/contracts/ipc-channels.ts` channel
`appListCliProxyProviders` / `"ccr:app:list-cliproxy-providers"` →
`management-server.ts` → `electron/src/main/ipc.ts` → `preload.ts` →
`ui/src/types/electron.d.ts` → `ui/src/web-client-bridge.ts`).

In the **Add/Edit Provider** dialog, account mode `"CLIProxyAPI provider"`
renders:

- CLIProxyAPI base URL (`cliproxyEndpoint`)
- Management key (`cliproxyManagementKey`)
- A **provider-id** field with a **Load providers** button that calls
  `window.ccr.listCliProxyProviders(...)` and a dropdown picker populated from
  the result.
- A **refresh** checkbox (`cliproxyRefresh`) controlling `?refresh=1`.

The UI round-trips through the shared draft model
(`createProviderAccountDraftFromConfig` ↔ `parseProviderAccountDraft` /
`providerCliproxyConnectorFromDraft`), so a configured provider reopens in the
same mode with its fields populated.

## 5. Example (local dev)

Services: CLIProxyAPI `http://127.0.0.1:8317`, CCR gateway `http://127.0.0.1:3456`,
CCR core `http://127.0.0.1:3457`.

A provider whose gateway config is:

```jsonc
{
  "id": "provider-2",
  "name": "provider-2",
  "api_base_url": "http://127.0.0.1:8317/v1",
  "api_key": "<management-key>",
  "protocolMode": "manual",
  "type": "anthropic_messages",
  "models": ["gpt-5.6-terra"]
}
```

gets a cliproxy account connector with `providerId =
"codex:account_a1b2c3d4e5f6"` (picked from the list). CCR then calls:

```
GET http://127.0.0.1:8317/v0/management/providers/codex%3Aaccount_a1b2c3d4e5f6/usage
Authorization: Bearer <management-key>
X-Management-Key: <management-key>
```

and renders the returned `meters` (e.g. a 5-hour window and a weekly window) in
the account/usage widget. The `provider-2::anthropic_messages` gateway provider
keeps being generated exactly as before — the account connector only adds usage.

## 6. Security

- CCR **never** sends an OAuth token to the usage endpoints and **never** needs
  to know which underlying upstream account is used. It sends only the management
  key and the stable provider ID.
- The management key is stored in CCR's existing (already-secret) `api_key` slot;
  no new secret material is introduced. When the management key differs from the
  provider `api_key`, it is stored via `connector.managementKey`.
- No real credentials, tokens, account IDs, or management keys are hardcoded in
  source or tests. Tests use the fake ID `codex:account_a1b2c3d4e5f6` and a
  local `node:http` mock of CLIProxyAPI.

## 7. Preserving the manual Anthropic protocol override

The manual `protocolMode: "manual"` override (commit `c5a6750`) is unrelated to
usage and is **not touched** by this integration. A provider can keep
`protocolMode: "manual"` (so the gateway emits `provider-2::anthropic_messages`)
and still gain a cliproxy usage connector — the two are independent fields.

## 8. Migration from the Python bridge (port 8321)

1. **Before removing anything**, verify the native connector: add the cliproxy
   account connector to the relevant provider, confirm the usage widget renders
   `meters`, and confirm a Claude Code request still flows end to end.
2. **Stop** the old bridge: `~/.local/share/ccr-quota-adapter/server.py` on
   port 8321.
3. **Archive** (do not delete) the bridge directory, e.g.
   `mv ~/.local/share/ccr-quota-adapter ~/.local/share/ccr-quota-adapter.archived`,
   so it can be restored if the native connector regresses. Per project policy,
   the old bridge is kept until the new integration is verified.
4. Remove any CCR provider that pointed at `http://127.0.0.1:8321` (the
   `http-json` account connector that wrapped the bridge) and replace it with the
   cliproxy account connector described here.

## 9. Testing

- **Core** (`tests/main/provider-cliproxy-usage.test.mjs`): 9 tests using a
  `node:http` mock of CLIProxyAPI — pure normalization, the factory, listing
  (auth headers, `/v1` strip, summary normalization), connector fetch
  (URL-encoded `providerId`, `api_key` reused as bearer, meter mapping),
  `?refresh=1`, upstream 403 → error, and missing `providerId` → error. No test
  contacts real services.
- **Renderer** (`tests/renderer/provider-cliproxy.test.ts`): 4 tests covering the
  UI draft↔config round-trip, optional-field omission, the empty-`providerId`
  validation error, and the disabled-account case.
- Run: `npm run typecheck`, `npm run test:main`, `npm run test:renderer`.

## 10. Implementation map

| Concern | Location |
| --- | --- |
| Contract types | `packages/core/src/contracts/app.ts` |
| Resolver + helpers + factory + listing | `packages/core/src/providers/account-service.ts` |
| IPC channel | `packages/core/src/contracts/ipc-channels.ts` |
| API method | `packages/core/src/web/management-server.ts` |
| Main handler | `packages/electron/src/main/ipc.ts` |
| Preload bridge | `packages/electron/src/main/preload.ts` |
| Renderer type decl | `packages/ui/src/types/electron.d.ts` |
| RPC bridge | `packages/ui/src/web-client-bridge.ts` |
| Draft model + mapping | `packages/ui/src/pages/home/shared/{types,options,providers}.ts` |
| Account picker UI | `packages/ui/src/pages/home/components/providers.tsx` |
| Core tests | `tests/main/provider-cliproxy-usage.test.mjs` |
| Renderer tests | `tests/renderer/provider-cliproxy.test.ts` |
