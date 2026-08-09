/**
 * Support Agent vertical contract:
 * standalone mobile home → choose immutable Cognia Support → send one real
 * provider-backed turn → Support-only controls and an editable feedback draft
 * are reachable, while diagnostics remain off until explicit consent.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

function anthropicMockBaseUrl(): string {
  const url = process.env.E2E_ANTHROPIC_BASE_URL
  if (!url) throw new Error("E2E_ANTHROPIC_BASE_URL was not published by global setup")
  return `${url.replace(/\/$/, "")}/v1`
}

test.describe("mobile — Cognia Support Agent", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone", {
      onboardingDismissedAt: "2026-08-07T00:00:00.000Z",
      defaultProvider: "anthropic",
      providerSettings: {
        anthropic: {
          enabled: true,
          apiKey: "test-e2e-key",
          baseURL: anthropicMockBaseUrl(),
        },
      },
    })
  })

  test("@critical is reachable, defaults diagnostics off, and drafts feedback from the live turn", async ({
    page,
  }) => {
    await page.getByTestId("mobile-quick-action-newChat").click()
    const picker = page.getByRole("dialog", { name: /pick a character/i })
    await expect(picker).toBeVisible()
    await picker.getByRole("option", { name: /Cognia Support/i }).click()

    const supportPanel = page.getByTestId("support-agent-panel")
    await expect(supportPanel).toBeVisible()
    await expect(
      supportPanel.getByRole("switch", { name: /Allow redacted local diagnostics/i })
    ).not.toBeChecked()

    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await composer.fill("diagnose the sidecar support e2e")
    await composer.press("Enter")
    await expect(
      page.getByText(/mock-anthropic-echo.*diagnose the sidecar support e2e/i).first()
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      supportPanel.getByRole("link", { name: /Open Cognia issue/i })
    ).toHaveAttribute("href", "https://github.com/MaxQian888/cognia-next/issues/new")

    await supportPanel
      .getByRole("button", { name: /Generate redacted support feedback/i })
      .click()
    const summary = page.getByRole("textbox", { name: /Feedback description/i })
    await expect(summary).toHaveValue(/diagnose the sidecar support e2e/i)
    await expect(summary).toHaveValue(/mock-anthropic-echo/i)
  })
})
