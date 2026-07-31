/**
 * Tauri E2E: the core chat flow across MORE THAN ONE turn.
 *
 * `reply-renders.spec.ts` proves a single compose → sidecar → stream → render
 * round-trip. This spec proves the session keeps a real conversation: two
 * sequential turns each stream their own reply through the real sidecar + mock
 * Anthropic, and both replies remain in the transcript (the second turn does
 * not wipe the first).
 *
 * The default `echo` scenario echoes the LAST user message, so each turn's
 * assistant bubble carries a DISTINCT marker (`mock-anthropic-echo] <that
 * turn's text>`) — letting us assert the two turns independently.
 *
 * Runs only under the `tauri` Playwright project (PLAYWRIGHT_TAURI=1).
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

test.describe("tauri: multi-turn chat conversation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("two sequential turns each stream their own reply and accumulate", async ({ page }) => {
    await page.goto("/")
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })

    // Turn 1.
    await composer.fill("first turn ping")
    await composer.press("Enter")
    await expect(page.getByText(/mock-anthropic-echo.*first turn ping/i).first()).toBeVisible({
      timeout: 60_000,
    })

    // Turn 2 — only possible once turn 1 settled the composer back to editable.
    await expect(composer).toBeEditable({ timeout: 30_000 })
    await composer.fill("second turn pong")
    await composer.press("Enter")
    await expect(page.getByText(/mock-anthropic-echo.*second turn pong/i).first()).toBeVisible({
      timeout: 60_000,
    })

    // Turn 1's reply is still on screen — the turns accumulate into one thread.
    await expect(page.getByText(/mock-anthropic-echo.*first turn ping/i).first()).toBeVisible()
  })
})
