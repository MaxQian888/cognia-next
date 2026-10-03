/**
 * Thin browser-owned coverage for the Codex-inspired desktop workflow entry
 * points. Native Git, Task Workspace, environment execution, Browser Adjust,
 * and CDP IPC remain owned by the Tauri/Rust suites.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureAppMounted, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

test.describe("web — Codex-inspired workflow entry", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureAppMounted(page)
    const mockBaseUrl = process.env.E2E_ANTHROPIC_BASE_URL
    if (!mockBaseUrl) throw new Error("Anthropic mock must be started by global setup")
    await setCogniaSettings(page, {
      defaultProvider: "anthropic",
      providerSettings: {
        anthropic: {
          enabled: true,
          apiKey: "test-e2e-key",
          baseURL: `${mockBaseUrl.replace(/\/$/, "")}/v1`,
        },
      },
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    })
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
  })

  test("@smoke @critical browser chat persists selected project execution and exposes workflow controls", async ({
    page,
  }) => {
    await page
      .getByRole("complementary", { name: "Conversations" })
      .getByRole("button", { name: /^Active workspace:/ })
      .click()
    await page.getByTestId("workspace-switcher-manage").click()

    const workspaces = page.getByRole("dialog", { name: "Workspaces" })
    await expect(workspaces).toBeVisible()
    await workspaces.getByTestId("workspace-new").click()
    await workspaces.getByRole("textbox", { name: "Name", exact: true }).fill("Workflow E2E")
    await workspaces.getByPlaceholder("Type an absolute path…").fill("/tmp/cognia-workflow-e2e")
    await workspaces.getByRole("button", { name: "Add folder" }).click()
    const saveWorkspace = workspaces.getByTestId("workspace-save")
    await saveWorkspace.scrollIntoViewIfNeeded()
    await saveWorkspace.click()
    await expect(page.getByText("Workspace created")).toBeVisible()

    const setActive = workspaces.getByRole("button", { name: "Set active" })
    if (await setActive.isVisible()) {
      await setActive.scrollIntoViewIfNeeded()
      await setActive.click()
    }
    await page.keyboard.press("Escape")

    // The native File → Quick Chat item is covered by the Tauri smoke path.
    // Web Playwright exercises the same startNewSession contract through the
    // ordinary New chat entry point, including project execution defaults.
    await page.getByRole("button", { name: "New chat" }).first().click()
    // The welcome composer creates the conversation on its first send.
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "Worktree", exact: true }).click()
    await page.getByTestId("ctxbar-worktree-off").click()
    await page.keyboard.press("Escape")
    await composer.fill("Check this workspace")
    await composer.press("Enter")
    await expect(
      page.getByRole("log").getByText("[mock-anthropic-echo] Check this workspace", { exact: true })
    ).toBeVisible()

    await expect
      .poll(async () => {
        const sessions = await page.evaluate(async () => {
          if (!window.__cogniaReadSessions) throw new Error("Session read bridge is unavailable")
          return window.__cogniaReadSessions()
        })
        return sessions.find(
          (row) => row.executionContext?.projectRoot === "/tmp/cognia-workflow-e2e"
        )
      })
      .toMatchObject({
        projectId: expect.any(String),
        executionContext: {
          location: "local",
          projectId: expect.any(String),
          projectRoot: "/tmp/cognia-workflow-e2e",
          taskWorkspace: { workspaceKey: expect.any(String) },
        },
      })

    const summary = page
      .getByTestId("title-bar-outlet-actions")
      .getByRole("button", { name: /^Task summary/ })
    if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click()
    await page
      .getByTestId("session-summary-card")
      .getByRole("button", { name: "Manage task", exact: true })
      .click()
    const settings = page.getByRole("dialog", { name: "Session settings" })
    const execution = settings.getByRole("button", { name: /^Execution overrides/ })
    if ((await execution.getAttribute("aria-expanded")) === "false") await execution.click()
    await expect(settings.getByText("Execution workspace")).toBeVisible()
    await expect(settings.getByText("Project environment")).toBeVisible()
    await page.keyboard.press("Escape")

    // The thread browser stays dormant until a subagent exists.
    await expect(page.getByRole("button", { name: "Browse agent threads" })).toHaveCount(0)
  })
})
