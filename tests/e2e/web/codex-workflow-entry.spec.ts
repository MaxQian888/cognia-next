/**
 * Thin browser-owned coverage for the Codex-inspired desktop workflow entry
 * points. Native Git, Task Workspace, environment execution, Browser Adjust,
 * and CDP IPC remain owned by the Tauri/Rust suites.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import {
  ensureCogniaAccount,
  readDexieRows,
  waitForPluginRuntimeReady,
  waitForTestGlobals,
} from "../helpers/db-reset"

interface PersistedSessionRow {
  id: string
  projectId?: string
  executionContext?: {
    location: "local" | "managedWorktree"
    projectId: string
    projectRoot: string
    taskWorkspace: { workspaceKey: string }
  }
}

test.describe("web — Codex-inspired workflow entry", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await waitForPluginRuntimeReady(page, 45_000)
    const providerOnboarding = page.getByRole("alertdialog", { name: "Welcome to Cognia" })
    if (await providerOnboarding.isVisible()) {
      await providerOnboarding.getByRole("button", { name: "Skip for now" }).click()
      await expect(providerOnboarding).toBeHidden()
    }
  })

  test("@smoke @critical Quick Chat persists project execution defaults and exposes workflow controls", async ({
    page,
  }) => {
    await page.getByTestId("workspace-switcher").click()
    await page.getByTestId("workspace-switcher-new").click()

    const workspaces = page.getByRole("dialog", { name: "Workspaces" })
    await expect(workspaces).toBeVisible()
    await workspaces.getByRole("textbox", { name: "Name", exact: true }).fill("Workflow E2E")
    await workspaces.getByPlaceholder("Type an absolute path…").fill("/tmp/cognia-workflow-e2e")
    await workspaces.getByRole("button", { name: "Add folder" }).click()
    const saveWorkspace = workspaces.getByTestId("workspace-save")
    await saveWorkspace.scrollIntoViewIfNeeded()
    await saveWorkspace.click()
    await expect(page.getByText("Workspace saved")).toBeVisible()

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
    const characterPicker = page.getByRole("dialog", { name: /pick a character/i })
    await expect(characterPicker).toBeVisible()
    await characterPicker.getByRole("option").first().click()
    await expect(page.getByRole("textbox", { name: /message/i }).first()).toBeVisible({
      timeout: 30_000,
    })

    await expect
      .poll(async () => {
        const sessions = await readDexieRows<PersistedSessionRow>(page, { table: "sessions" })
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

    await page.getByRole("button", { name: "Session settings" }).click()
    const settings = page.getByRole("dialog", { name: "Session settings" })
    await expect(settings.getByText("Execution workspace")).toBeVisible()
    await expect(settings.getByText("Project environment")).toBeVisible()
    await page.keyboard.press("Escape")

    const browseThreads = page.getByRole("button", { name: "Browse agent threads" })
    await browseThreads.focus()
    await browseThreads.press("Enter")
    await expect(page.getByRole("dialog", { name: "Agent threads" })).toBeVisible()
  })
})
