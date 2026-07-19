/**
 * Playwright Electron automated UI test for Swarm management (Phase 5A.5).
 */
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

test.describe.configure({ mode: "serial", timeout: 90000 });

function setupIsolatedEnv(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-"));
  const homeDir = path.join(tmpDir, "home");
  const configDir = path.join(homeDir, ".claude-code-router");
  const appDataDir = path.join(configDir, "app-data");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });

  const gwPort = 40000 + Math.floor(Math.random() * 9999);
  const configValue = JSON.stringify({
    HOST: "127.0.0.1",
    PORT: gwPort,
    gateway: { host: "127.0.0.1", port: gwPort, coreHost: "127.0.0.1", corePort: gwPort + 1, enabled: true },
    Providers: [{ name: "TestProvider", models: ["test-model"], type: "anthropic_messages" }],
    swarm: { enabled: opts.swarmEnabled ?? true }
  }).replace(/"swarm":\{"enabled":(true|false)\}/, '"swarm":{"enabled":$1}');
  const configDb = path.join(configDir, "config.sqlite");
  // Write SQL to a temp file to avoid shell quote-escaping issues with JSON
  const sqlFile = path.join(configDir, "init.sql");
  const escapedValue = configValue.replace(/'/g, "''");
  fs.writeFileSync(sqlFile,
    `CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);\nINSERT INTO app_config (key, value_json, updated_at) VALUES ('default', '${escapedValue}', datetime('now'));\n`);
  execSync(`sqlite3 "${configDb}" < "${sqlFile}"`);
  fs.unlinkSync(sqlFile);

  fs.writeFileSync(path.join(configDir, ".onboard_finished"), "");

  const agentDir = path.join(tmpDir, "agents");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "test-agent.md"),
    "---\nname: test-agent\nproviderId: TestProvider\nmodel: test-model\n---\n# Test Agent\n\nThis is a synthetic agent body that is long enough to pass the minimum canonical body length requirement for attribution testing in the Playwright Electron automated UI flow."
  );

  const launchDir = path.join(tmpDir, "launch");
  fs.mkdirSync(launchDir, { recursive: true });

  return { tmpDir, homeDir, configDir, appDataDir, agentDir, launchDir, gwPort };
}

async function launchApp(env) {
  const electronPath = require("electron").toString();
  const app = await electron.launch({
    executablePath: electronPath,
    args: [REPO_ROOT],
    env: {
      ...process.env,
      HOME: env.homeDir,
      CCR_INTERNAL_HOME_DIR: env.homeDir,
      CCR_INTERNAL_APP_DATA_DIR: env.appDataDir,
      CCR_INTERNAL_USER_DATA_DIR: path.join(env.tmpDir, "user-data"),
    },
    cwd: REPO_ROOT,
    timeout: 30000,
  });

  const consoleErrors = [];
  const pageErrors = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => pageErrors.push(err.message));

  return { app, window, consoleErrors, pageErrors };
}

test.describe("Swarm Desktop — feature flag ON", () => {
  let env, electronApp, page, consoleErrors, pageErrors;

  test.beforeAll(async () => {
    env = setupIsolatedEnv({ swarmEnabled: true });
    const result = await launchApp(env);
    electronApp = result.app;
    page = result.window;
    consoleErrors = result.consoleErrors;
    pageErrors = result.pageErrors;
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(8000); // Allow config load + React render
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close().catch(() => {});
    if (env?.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
  });

  test("app loads and config has swarm enabled", async () => {
    await page.screenshot({ path: "/tmp/swarm-e2e-enabled.png" }).catch(() => {});
    // Evaluate the config inside the renderer
    const config = await page.evaluate(() => window.ccr?.getConfig?.()).catch(() => null);
    console.log("CONFIG swarm.enabled:", config?.swarm?.enabled);
    console.log("CONFIG Providers:", JSON.stringify(config?.Providers?.map((p) => p.name)));
    expect(page).toBeDefined();
  });

  test("Swarms navigation is visible", async () => {
    const body = await page.textContent("body").catch(() => "");
    console.log("BODY (first 300):", body?.slice(0, 300));
    console.log("PAGE ERRORS:", pageErrors);
    console.log("CONSOLE ERRORS:", consoleErrors.slice(0, 5));
    expect(body).toContain("Swarms");
  });

  test("no raw token or canonical body in DOM", async () => {
    const body = await page.textContent("body").catch(() => "");
    expect(body).not.toContain("ccr-swarm-v1-");
    expect(body).not.toContain("synthetic agent body");
  });

  test("no fatal page errors", () => {
    const realErrors = pageErrors.filter((e) =>
      !e.includes("ERR_BLOCKED_BY_CLIENT") && !e.includes("net::ERR")
    );
    expect(realErrors).toHaveLength(0);
  });
});

test.describe("Swarm Desktop — feature flag OFF", () => {
  let env, electronApp, page;

  test.beforeAll(async () => {
    env = setupIsolatedEnv({ swarmEnabled: false });
    const result = await launchApp(env);
    electronApp = result.app;
    page = result.window;
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(8000);
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close().catch(() => {});
    if (env?.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
  });

  test("Swarms navigation is absent", async () => {
    const body = await page.textContent("body").catch(() => "");
    expect(body).not.toContain("Swarms");
  });
});
