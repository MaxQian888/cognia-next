/**
 * Browser-runnable coverage for the main chat lifecycle branches that were
 * previously Tauri-only. Every test owns a private Anthropic mock instance so
 * slow/error scenarios remain hermetic under Playwright's fully-parallel mode.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { createMockAnthropicServer, type MockAnthropicServer } from "../mocks/anthropic/server"
import {
  ensureCogniaAccount,
  setCogniaSettings,
  waitForPluginRuntimeReady,
  waitForTestGlobals,
} from "../helpers/db-reset"

let anthropic: MockAnthropicServer

async function configureStandaloneChat(page: Page): Promise<void> {
  await page.goto("/")
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await waitForTestGlobals(page, 30_000)
  await waitForPluginRuntimeReady(page, 45_000)
  await setCogniaSettings(page, {
    defaultProvider: "anthropic",
    providerSettings: {
      anthropic: {
        enabled: true,
        apiKey: "test-e2e-key",
        baseURL: `${anthropic.baseUrl}/v1`,
      },
    },
  })
}

async function openNewChat(page: Page) {
  await page.getByRole("button", { name: "New chat" }).first().click()
  const picker = page.getByRole("dialog", { name: /pick a character/i })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.getByRole("option").first().click()
  const composer = page.getByRole("textbox", { name: /message/i }).first()
  await expect(composer).toBeVisible({ timeout: 30_000 })
  return composer
}

test.describe("web — main chat lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    anthropic = createMockAnthropicServer()
    await anthropic.start()
    await configureStandaloneChat(page)
  })

  test.afterEach(async () => {
    await anthropic.stop()
  })

  test("@critical accumulates two durable turns in one conversation", async ({ page }) => {
    const composer = await openNewChat(page)

    await composer.fill("first browser lifecycle turn")
    await composer.press("Enter")
    await expect(
      page.getByText(/mock-anthropic-echo.*first browser lifecycle turn/i).first()
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Send" }).first()).toBeVisible({
      timeout: 30_000,
    })

    await composer.fill("second browser lifecycle turn")
    await composer.press("Enter")
    await expect(
      page.getByText(/mock-anthropic-echo.*second browser lifecycle turn/i).first()
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Send" }).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId("perf-hud-row-chat:turn:completed")).toBeVisible({
      timeout: 10_000,
    })

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(
      page.getByText(/mock-anthropic-echo.*first browser lifecycle turn/i).first()
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      page.getByText(/mock-anthropic-echo.*second browser lifecycle turn/i).first()
    ).toBeVisible({ timeout: 20_000 })
  })

  test("@critical surfaces a permanent provider failure and accepts the next turn", async ({
    page,
  }) => {
    anthropic.setMessagesScenario({ kind: "auth-error" })
    const composer = await openNewChat(page)

    await composer.fill("fail this browser lifecycle turn")
    await composer.press("Enter")

    await expect(page.getByTestId("inline-error")).toBeVisible({ timeout: 30_000 })
    await expect(composer).toBeEditable({ timeout: 30_000 })
    await expect(page.getByTestId("perf-hud-row-chat:turn:failed")).toBeVisible({
      timeout: 10_000,
    })

    anthropic.setMessagesScenario({ kind: "echo", suffix: "recovered" })
    await composer.fill("recover after browser failure")
    await composer.press("Enter")
    await expect(
      page.getByText(/mock-anthropic-echo:recovered.*recover after browser failure/i).first()
    ).toBeVisible({ timeout: 30_000 })
  })

  test("@critical interrupts a live stream and completes a subsequent turn", async ({ page }) => {
    anthropic.setMessagesScenario({
      kind: "stream-text",
      chunks: Array.from({ length: 30 }, (_, index) => `slow-${index} `),
      delayMs: 200,
    })
    const composer = await openNewChat(page)

    await composer.fill("interrupt this browser lifecycle turn")
    await composer.press("Enter")

    const stop = page.getByRole("button", { name: /stop/i }).first()
    await expect(stop).toBeVisible({ timeout: 30_000 })
    await stop.click()
    await expect(composer).toBeEditable({ timeout: 30_000 })
    await expect(page.getByTestId("perf-hud-row-chat:turn:cancelled")).toBeVisible({
      timeout: 10_000,
    })

    anthropic.setMessagesScenario({ kind: "echo", suffix: "after-stop" })
    await composer.fill("send after browser interruption")
    await composer.press("Enter")
    await expect(
      page.getByText(/mock-anthropic-echo:after-stop.*send after browser interruption/i).first()
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("slow-29")).toHaveCount(0)
  })
})
