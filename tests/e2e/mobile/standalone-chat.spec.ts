/**
 * E2E: standalone (BYOK) chat — compose → send → streamed reply → persists.
 *
 * The desktop browser build renders a "desktop only" banner instead of a
 * chat pane, so the default-project core contract belongs to the Capacitor
 * shell's standalone mode. The phone chats in-webview against the user's own
 * provider keys; this spec points an Anthropic BYOK credential at the
 * deterministic mock and drives the real composer through persistence.
 *
 * Hermeticity proof (ported from the tauri chat spec): the mock's echo
 * scenario prefixes replies with "[mock-anthropic-echo]", a marker the real
 * Anthropic API could never produce — its presence proves the turn
 * round-tripped through the standalone engine AND the mock, not the network.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

function anthropicMockBaseUrl(): string {
  const url = process.env.E2E_ANTHROPIC_BASE_URL
  if (!url) {
    throw new Error(
      "E2E_ANTHROPIC_BASE_URL not published — global-setup didn't boot the anthropic mock"
    )
  }
  return `${url.replace(/\/$/, "")}/v1`
}

test.describe("mobile — standalone chat", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone", {
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

  test("@smoke @critical sending a message streams and restores the reply", async ({ page }) => {
    await page.goto("/")
    // The chat tab lands on the quick-actions home — enter a session first.
    const newChat = page.getByTestId("mobile-quick-action-newChat")
    await expect(newChat).toBeVisible({ timeout: 20_000 })
    await newChat.click()
    // New chat opens the character picker — take the first built-in.
    const picker = page.getByRole("dialog", { name: /pick a character/i })
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await picker.getByRole("option").first().click()
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 20_000 })

    await composer.fill("ping from standalone chat e2e")
    await composer.press("Enter")

    // The echo marker proves the reply came through the mock — and the echo
    // carries the exact prompt text, so a reply to some OTHER message can't
    // satisfy this either.
    await expect(
      page.getByText(/mock-anthropic-echo.*ping from standalone chat e2e/).first()
    ).toBeVisible({ timeout: 30_000 })

    await page.reload()
    await expect(page.getByText("ping from standalone chat e2e").first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      page.getByText(/mock-anthropic-echo.*ping from standalone chat e2e/).first()
    ).toBeVisible({ timeout: 20_000 })
  })
})
