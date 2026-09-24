/**
 * E2E: ordinary browser standalone (BYOK) chat.
 *
 * This deliberately does not inject Capacitor or Tauri. It proves the plain
 * Web runtime reaches the shared chat pane, executes the browser AI SDK
 * engine against a configured Provider, and restores the durable turn.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

interface PersistedChatRow {
  database: string
  role: string
  text: string
}

function anthropicMockBaseUrl(): string {
  const url = process.env.E2E_ANTHROPIC_BASE_URL
  if (!url) {
    throw new Error(
      "E2E_ANTHROPIC_BASE_URL not published — global-setup didn't boot the anthropic mock"
    )
  }
  return `${url.replace(/\/$/, "")}/v1`
}

/**
 * The chat rows the account database durably holds, read through the app's
 * own Dexie. The account database is encrypted at rest (`-encrypted-v1`), so a
 * raw IndexedDB read sees only the content envelope, never a role or a text.
 */
async function readPersistedChatRows(page: Page) {
  return page.evaluate(async (): Promise<PersistedChatRow[]> => {
    const read = (window as { __cogniaReadMessages?: () => Promise<PersistedChatRow[]> })
      .__cogniaReadMessages
    if (typeof read !== "function") throw new Error("window.__cogniaReadMessages is not exposed")
    return (await read()).map(({ database, role, text }) => ({ database, role, text }))
  })
}

test.describe("web — standalone chat", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await setCogniaSettings(page, {
      defaultProvider: "anthropic",
      providerSettings: {
        anthropic: {
          enabled: true,
          apiKey: "test-e2e-key",
          baseURL: anthropicMockBaseUrl(),
        },
      },
      // ADR-0122: the seeded account has zero sessions, so the onboarding gate
      // routes it into the first-run flow unless a settled record says the
      // device has already been through it.
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    })
  })

  test("@smoke @critical sends, streams, and restores a browser-native turn", async ({ page }) => {
    // The gate's verdict latches per boot; re-boot so it reads the settled row.
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })

    // "New chat" lands on the welcome surface, whose live composer creates the
    // conversation on its first send — no character pick in between.
    await page.getByRole("button", { name: "New chat", exact: true }).first().click()
    await expect(
      page.getByTestId("welcome-composer").getByRole("textbox", { name: /message/i })
    ).toBeVisible({ timeout: 30_000 })
    // Not scoped to the welcome surface: once the first send lands, the
    // conversation view replaces it and the docked composer takes the role.
    const composer = page.getByRole("textbox", { name: /message/i }).first()

    await composer.fill("ping from ordinary web standalone")
    await composer.press("Enter")

    await expect(
      page.getByText(/mock-anthropic-echo.*ping from ordinary web standalone/i).first()
    ).toBeVisible({ timeout: 30_000 })
    // The response text can render before the final Dexie transaction commits.
    // The composer returns from Stop to Send only after turnComplete has awaited
    // that durable snapshot, so this is the reload-safe terminal state.
    await expect(page.getByRole("button", { name: "Send" }).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(async () => readPersistedChatRows(page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            database: expect.stringMatching(/^cognia-account-/),
            role: "assistant",
            text: expect.stringMatching(/mock-anthropic-echo.*ping from ordinary web standalone/i),
          }),
        ])
      )

    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByText("ping from ordinary web standalone").first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      page.getByText(/mock-anthropic-echo.*ping from ordinary web standalone/i).first()
    ).toBeVisible({ timeout: 20_000 })
  })
})
