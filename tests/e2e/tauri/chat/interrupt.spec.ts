/**
 * Tauri E2E: the chat flow's INTERRUPT branch.
 *
 * Drives the real compose → sidecar → stream path against a deliberately slow,
 * many-chunk stream (the `stream-text` scenario with a per-chunk `delayMs`) so
 * the turn stays in the live "streaming" state long enough to catch the Stop
 * control. Clicking Stop issues `claude_interrupt` to the real sidecar, which
 * tears down the in-flight SDK query; we assert the session settles back to
 * idle (the composer becomes interactive again and accepts a new message).
 *
 * The mock instance is shared across the whole run, so `afterEach` resets it
 * back to the default `echo` scenario.
 *
 * Runs only under the `tauri` Playwright project (PLAYWRIGHT_TAURI=1).
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import { resetAnthropic, setAnthropicScenario } from "../../helpers/anthropic-control"

test.describe("tauri: interrupting a streaming turn", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test.afterEach(async () => {
    await resetAnthropic()
  })

  test("Stop halts the stream and the composer settles back to idle", async ({ page }) => {
    // 30 chunks × 400 ms ≈ 12 s of streaming — ample room to click Stop before
    // the turn would finish on its own.
    await setAnthropicScenario({
      kind: "stream-text",
      chunks: Array.from({ length: 30 }, (_, i) => `chunk-${i} `),
      delayMs: 400,
    })

    await page.goto("/")
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })

    await composer.fill("start a long stream then stop it")
    await composer.press("Enter")

    // Once streaming, the primary composer button morphs from Send into Stop.
    const stopBtn = page.getByRole("button", { name: /^stop$/i }).first()
    await expect(stopBtn).toBeVisible({ timeout: 30_000 })
    await stopBtn.click()

    // After the interrupt the turn settles: the composer is interactive again
    // and accepts a fresh message (a session stuck "streaming" would block this).
    await expect(composer).toBeEditable({ timeout: 30_000 })
    await composer.fill("typed after interrupt")
    await expect(composer).toHaveValue("typed after interrupt")
  })
})
