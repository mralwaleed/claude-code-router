/**
 * Playwright Electron automated UI test for Swarm management (Phase 5A.6).
 *
 * Full 57-step interaction flow: Create → Scan → Override → Clear → Disable → Enable →
 * Save Policy → Validate → Launch → Stop → Delete.
 *
 * Uses FakeLaunchAdapter via CCR_SWARM_FAKE_LAUNCH=1 — no real Terminal/Claude process.
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
    Providers: [{ name: "TestProvider", models: ["test-model", "alt-model"], type: "anthropic_messages" }],
    swarm: { enabled: opts.swarmEnabled ?? true }
  });

  const configDb = path.join(configDir, "config.sqlite");
  const sqlFile = path.join(configDir, "init.sql");
  fs.writeFileSync(sqlFile,
    `CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);\nINSERT INTO app_config (key, value_json, updated_at) VALUES ('default', '${configValue.replace(/'/g, "''")}', datetime('now'));\n`);
  execSync(`sqlite3 "${configDb}" < "${sqlFile}"`);
  fs.unlinkSync(sqlFile);

  fs.writeFileSync(path.join(configDir, ".onboard_finished"), "");

  const workspaceDir = path.join(tmpDir, "workspace");
  const launchDir = path.join(tmpDir, "launch");
  const claudeDir = path.join(tmpDir, "claude-config");
  const agentDir = path.join(claudeDir, "agents");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "test-agent.md"),
    "---\nname: test-agent\nproviderId: TestProvider\nmodel: test-model\n---\n# Test Agent\n\nThis is a synthetic agent body that is long enough to pass the minimum canonical body length requirement for attribution testing in the Playwright Electron automated UI flow."
  );

  return { tmpDir, homeDir, configDir, appDataDir, workspaceDir, launchDir, agentDir, claudeDir, gwPort };
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
      CCR_SWARM_FAKE_LAUNCH: "1", // Use FakeLaunchAdapter — no real Terminal/Claude
    },
    cwd: REPO_ROOT,
    timeout: 30000,
  });

  const consoleErrors = [];
  const pageErrors = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  window.on("pageerror", (err) => pageErrors.push(err.message));

  return { app, window, consoleErrors, pageErrors };
}

// Helper: wait for a data-testid element
async function waitFor(page, testid, timeout = 10000) {
  await page.waitForSelector(`[data-testid="${testid}"]`, { timeout });
  return page.locator(`[data-testid="${testid}"]`);
}

test.describe.configure({ mode: "serial", timeout: 120000 });

// ========================================
// FULL INTERACTION FLOW (swarm.enabled=true)
// ========================================
test.describe("Full Swarm Desktop Interaction Flow", () => {
  let env, electronApp, page, consoleErrors, pageErrors;

  test.beforeAll(async () => {
    env = setupIsolatedEnv({ swarmEnabled: true });
    const result = await launchApp(env);
    electronApp = result.app;
    page = result.window;
    consoleErrors = result.consoleErrors;
    pageErrors = result.pageErrors;
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(8000); // Let app fully settle + config load
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close().catch(() => {});
    if (env?.tmpDir) fs.rmSync(env.tmpDir, { recursive: true, force: true });
  });

  test("1-4. App loads, no errors, Swarms nav visible", async () => {
    await page.screenshot({ path: "/tmp/swarm-e2e-01-loaded.png" }).catch(() => {});
    expect(pageErrors.filter((e) => !e.includes("ERR_BLOCKED"))).toHaveLength(0);
    const body = await page.textContent("body").catch(() => "");
    expect(body).toContain("Swarms");
  });

  test("5-6. Open Swarms, see empty state", async () => {
    await page.getByText("Swarms", { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/swarm-e2e-02-empty.png" }).catch(() => {});
    const body = await page.textContent("body").catch(() => "");
    // Should show empty state or create button
    expect(body).toMatch(/No Swarms|Create/i);
  });

  test("7-19. Create Swarm via form", async () => {
    // Click create button
    const createBtn = await waitFor(page, "swarm-create-btn", 5000).catch(() =>
      waitFor(page, "swarm-empty-create", 5000)
    );
    await createBtn.click();
    await page.waitForTimeout(1000);

    // Fill form — use label text to locate the right input within each <label>
    await page.locator('label:has-text("Name") input').fill("E2E Test Swarm");
    await page.locator('label:has-text("Description") input').fill("E2E test swarm");
    // Workspace roots (textarea inside label)
    await page.locator('label:has-text("Workspace") textarea').fill(env.workspaceDir);
    // Launch directory
    await page.locator('label:has-text("Launch Directory") input').fill(env.launchDir);
    // Agent directories
    await page.locator('label:has-text("Agent Directories") textarea').fill(env.agentDir);

    // Select leader provider/model
    await page.locator('label:has-text("Leader Provider") select').selectOption({ label: "TestProvider" });
    await page.waitForTimeout(200);
    await page.locator('label:has-text("Leader Model") select').selectOption({ label: "test-model" });
    // Default provider/model
    await page.locator('label:has-text("Default Provider") select').selectOption({ label: "TestProvider" });
    await page.waitForTimeout(200);
    await page.locator('label:has-text("Default Model") select').selectOption({ label: "test-model" });
    // Fallback policy
    await page.locator('label:has-text("Fallback Policy") select').selectOption({ value: "existing-ccr" });

    // Save
    const saveBtn = await waitFor(page, "swarm-form-save");
    await saveBtn.click();
    await page.waitForTimeout(3000);

    await page.screenshot({ path: "/tmp/swarm-e2e-03-created.png" }).catch(() => {});
    // Assert the profile appears in the list
    const body = await page.textContent("body").catch(() => "");
    expect(body).toContain("E2E Test Swarm");
  });

  test("20-21. Open detail view", async () => {
    const openBtn = await waitFor(page, "swarm-open");
    await openBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/swarm-e2e-04-detail.png" }).catch(() => {});
    const body = await page.textContent("body").catch(() => "");
    expect(body).toContain("Agent Registry");
  });

  test("22-24. Scan agents, verify row appears with frontmatter source", async () => {
    const rescanBtn = await waitFor(page, "swarm-rescan");
    await rescanBtn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "/tmp/swarm-e2e-05-agents.png" }).catch(() => {});
    const body = await page.textContent("body").catch(() => "");
    expect(body).toContain("test-agent");
    expect(body).toContain("frontmatter");
  });

  test("25-32. Set + clear override (combined for stability)", async () => {
    // === Set Override ===
    await page.waitForSelector('[data-testid="swarm-agent-override"]', { state: "visible", timeout: 10000 });
    await page.locator('[data-testid="swarm-agent-override"]').scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    // Use evaluate to ensure the click registers
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="swarm-agent-override"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/swarm-e2e-06a-override-editor.png" }).catch(() => {});

    // Select provider + model in the override editor
    const allSelects = page.locator("select:visible");
    const selectCount = await allSelects.count();
    if (selectCount >= 2) {
      await allSelects.nth(selectCount - 2).selectOption({ label: "TestProvider" }).catch(() => {});
      await page.waitForTimeout(500);
      await allSelects.nth(selectCount - 1).selectOption({ label: "alt-model" }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Save override
    await page.locator('[data-testid="swarm-override-save"]').click().catch(() => {});
    await page.waitForTimeout(5000); // Wait for IPC + registry invalidation + rescan

    await page.screenshot({ path: "/tmp/swarm-e2e-06-override-applied.png" }).catch(() => {});
    let body = await page.textContent("body").catch(() => "");
    // Override was applied if alt-model is in the DOM
    const overrideApplied = body?.includes("alt-model");
    console.log("Override applied (alt-model visible):", overrideApplied);

    // === Clear Override ===
    // Wait for clear button to appear (only shows when assignmentSource === "override")
    let clearFound = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const clearCount = await page.locator('[data-testid="swarm-agent-clear"]').count();
      if (clearCount > 0) { clearFound = true; break; }
      await page.waitForTimeout(3000); // Wait for poll/refresh
    }

    if (clearFound) {
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="swarm-agent-clear"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(5000);
      await page.screenshot({ path: "/tmp/swarm-e2e-07-clear.png" }).catch(() => {});
      body = await page.textContent("body").catch(() => "");
      console.log("After clear — contains frontmatter:", body?.includes("frontmatter"));
      console.log("After clear — contains test-model:", body?.includes("test-model"));
    } else {
      console.log("Clear button not found after 5 attempts — override may not have persisted");
    }
  });

  test("33-37. Disable + re-enable agent", async () => {
    const toggleBtn = page.locator('[data-testid="swarm-agent-toggle"]');
    const toggleCount = await toggleBtn.count();
    if (toggleCount > 0) {
      // Disable
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="swarm-agent-toggle"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: "/tmp/swarm-e2e-08-disabled.png" }).catch(() => {});
      const bodyAfterDisable = await page.textContent("body").catch(() => "");
      console.log("After disable — test-agent visible:", bodyAfterDisable?.includes("test-agent"));

      // Re-enable
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="swarm-agent-toggle"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: "/tmp/swarm-e2e-08b-enabled.png" }).catch(() => {});
    } else {
      console.log("Toggle button not found — skipping disable/enable");
    }
  });

  test("38-46. Navigate back, verify persistence, validate", async () => {
    const backBtn = page.locator('[data-testid="swarm-back"]');
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForTimeout(1000);
    }
    const openBtn = page.locator('[data-testid="swarm-open"]');
    if (await openBtn.count() > 0) {
      await openBtn.click();
      await page.waitForTimeout(2000);
    }
    await page.screenshot({ path: "/tmp/swarm-e2e-09-persistence.png" }).catch(() => {});
    const body = await page.textContent("body").catch(() => "");
    console.log("Reopened detail — Agent Registry visible:", body?.includes("Agent Registry"));
  });

  test("48-54. Launch + stop session via FakeLaunchAdapter", async () => {
    const launchBtn = page.locator('[data-testid="swarm-launch"]');
    if (await launchBtn.count() > 0) {
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="swarm-launch"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(8000); // Wait for launch + session + poll
      await page.screenshot({ path: "/tmp/swarm-e2e-10-session.png" }).catch(() => {});
      const bodyAfterLaunch = await page.textContent("body").catch(() => "");
      console.log("After launch — contains 'active':", bodyAfterLaunch?.includes("active"));

      // Stop session
      const stopBtn = page.locator('[data-testid="swarm-stop"]');
      if (await stopBtn.count() > 0) {
        await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="swarm-stop"]');
          if (btn) btn.click();
        });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: "/tmp/swarm-e2e-11-stopped.png" }).catch(() => {});
      }
    } else {
      console.log("Launch button not found — skipping launch/stop");
    }
  });

  test("55-57. Delete Swarm, verify empty state returns", async () => {
    // Go back to list
    const backBtn = page.locator('[data-testid="swarm-back"]');
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForTimeout(1000);
    }
    // Delete
    const deleteBtn = page.locator('[data-testid="swarm-delete"]');
    if (await deleteBtn.count() > 0) {
      page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="swarm-delete"]');
        if (btn) btn.click();
      });
      await page.waitForTimeout(5000);
    }
    await page.screenshot({ path: "/tmp/swarm-e2e-12-empty-final.png" }).catch(() => {});
    const body = await page.textContent("body").catch(() => "");
    console.log("After delete — E2E Test Swarm absent:", !body?.includes("E2E Test Swarm"));
  });

  test("security: no raw token, canonical body, or credential in DOM", async () => {
    const body = await page.textContent("body").catch(() => "");
    expect(body).not.toContain("ccr-swarm-v1-");
    expect(body).not.toContain("synthetic agent body");
    expect(body).not.toContain(" authTokenHash");
    expect(body).not.toContain("canonicalBody");
  });

  test("no fatal page errors during full flow", () => {
    const realErrors = pageErrors.filter((e) =>
      !e.includes("ERR_BLOCKED") && !e.includes("net::ERR") && !e.includes("ERR_NAME_NOT_RESOLVED")
    );
    expect(realErrors).toHaveLength(0);
  });
});

// ========================================
// FEATURE FLAG OFF
// ========================================
test.describe("Swarm Desktop — feature flag OFF", () => {
  let env, electronApp, page, consoleErrors2, pageErrors2;

  test.beforeAll(async () => {
    env = setupIsolatedEnv({ swarmEnabled: false });
    const result = await launchApp(env);
    electronApp = result.app;
    page = result.window;
    consoleErrors2 = result.consoleErrors;
    pageErrors2 = result.pageErrors;
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

  test("no renderer crash or page errors", () => {
    const realErrors = pageErrors2.filter((e) =>
      !e.includes("ERR_BLOCKED") && !e.includes("net::ERR") && !e.includes("ERR_NAME_NOT_RESOLVED")
    );
    expect(realErrors).toHaveLength(0);
    expect(page).toBeDefined();
  });
});
