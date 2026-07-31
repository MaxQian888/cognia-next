/**
 * Tauri E2E: the chat flow's FAILURE branch.
 *
 * `reply-renders.spec.ts` covers the happy path. This spec drives the SAME real
 * compose → sidecar → stream path, but points the shared mock Anthropic server
 * at an `auth-error` (401) scenario so the turn fails upstream. We assert two
 * things a regression would silently break:
 *   1. the failure surfaces as the inline error banner (not a hung spinner or a
 *      blank assistant bubble) — `setSessionError` → `<InlineError>`;
 *   2. the session is NOT wedged in "streaming": the composer recovers and a
 *      new message can be typed.
 *
 * `auth-error` is chosen over `server-error`/`rate-limited` because 401 is a
 * permanent, non-retryable failure — the turn fails fast and deterministically
 * with no SDK backoff/retry churn.
 *
 * The mock instance is shared across the whole run, so `afterEach` resets it
 * back to the default `echo` scenario — a leftover 401 would break every later
 * chat/workflow spec.
 *
 * Runs only under the `tauri` Playwright project (PLAYWRIGHT_TAURI=1).
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import { resetAnthropic, setAnthropicScenario } from "../../helpers/anthropic-control"

test.describe("tauri: chat surfaces an upstream failure", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test.afterEach(async () => {
    await resetAnthropic()
  })

  test("an upstream auth error renders an inline error and the composer recovers", async ({
    page,
  }) => {
    await setAnthropicScenario({ kind: "auth-error" })

    await page.goto("/")
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })

    await composer.fill("trigger an upstream failure")
    await composer.press("Enter")

    // The failed turn renders the inline error banner instead of a reply bubble.
    await expect(page.getByTestId("inline-error")).toBeVisible({ timeout: 60_000 })

    // The session settled to idle — a wedged "streaming" session would block this.
    await expect(composer).toBeEditable({ timeout: 30_000 })
    await composer.fill("recovered after the error")
    await expect(composer).toHaveValue("recovered after the error")
  })
})
