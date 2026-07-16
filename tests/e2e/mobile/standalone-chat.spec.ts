/**
 * E2E: standalone (BYOK) chat — compose → send → streamed reply → persists.
 *
 * The main chat flow previously had ZERO coverage in any project that runs
 * by default: the desktop browser build renders a "desktop only" banner
 * instead of a chat pane, and the only chat specs lived in the tauri project
 * (which collected 0 tests until W1.1, and is Windows-only by design). The
 * browser-runnable chat surface is the Capacitor shell's standalone mode,
 * where the phone chats in-webview against the user's own provider keys —
 * so this spec seeds an Anthropic BYOK credential pointing at the mock
 * Anthropic server and drives the real composer.
 *
 * Hermeticity proof (ported from the tauri chat spec): the mock's echo
 * scenario prefixes replies with "[mock-anthropic-echo]", a marker the real
 * Anthropic API could never produce — its presence proves the turn
 * round-tripped through the standalone engine AND the mock, not the network.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

function anthropicMockBaseUrl(): string {
  const url = process.env.E2E_ANTHROPIC_BASE_URL
  if (!url) {
    throw new Error(
      "E2E_ANTHROPIC_BASE_URL not published — global-setup didn't boot the anthropic mock"
    )
  }
  return url
}

test.describe("mobile — standalone chat", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    await setCogniaSettings(page, {
      mobileRuntimeMode: "standalone",
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

  // FIXME(dormant feature): the standalone engine (lib/ai/chat/
  // standalone-engine.ts runStandaloneTurn) has ZERO product callers — the
  // whole BYOK path exists (mode chooser, provider settings, credential
  // probe, engine, unit tests) but the mobile composer's send was never
  // routed to it, so the user message renders and no reply ever comes.
  // This spec is the falsifiable pin for that wiring: flip fixme → test once
  // the composer dispatches standalone turns. Recorded in
  // docs/plans/2026-07-16-e2e-suite-revival.md §7.
  test.fixme("sending a message renders a streamed mock reply", async ({ page }) => {
    await page.goto("/")
    // The chat tab lands on the quick-actions home — enter a session first.
    const newChat = page.getByRole("button", { name: /new chat/i }).first()
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
  })
})
