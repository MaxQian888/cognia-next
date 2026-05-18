/**
 * Tauri E2E: OpenCode-Zen paste-key add-account flow.
 *
 * Unlike the Anthropic OAuth / Codex Reuse flows, the Zen path is a direct
 * paste: the user copies an API key from opencode.ai/auth and pastes it.
 * The renderer just calls `opencode_save_zen_key` (Tauri command) which
 * writes the credential into the unified vault.
 *
 * Happy path: paste a key + custom base URL → save → account appears.
 * Edge case: save button is disabled while the key field is empty.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import { listAccountsForProvider, resetSubscriptionState } from "../../helpers/subscription"

test.describe("tauri: OpenCode-Zen paste key", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await resetSubscriptionState(page)
  })

  test("happy path: paste key, base URL, label → account saved", async ({ page }) => {
    await page.goto("/settings?section=subscription&subTab=opencode")

    await page.getByRole("button", { name: "Add account" }).first().click()

    const dialog = page.getByRole("dialog", { name: /OpenCode-Zen subscription/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    await dialog.getByLabel(/Zen API key/i).fill("zen_e2e_test_key_xyz123")
    await dialog.getByLabel(/Base URL/i).fill("https://zen-mock.example.com/api")
    await dialog.getByLabel(/^Label/i).fill("e2e-opencode")

    await dialog.getByRole("button", { name: /Save Zen key/i }).click()

    await expect(dialog).toBeHidden({ timeout: 10_000 })

    const accounts = await listAccountsForProvider(page, "opencode")
    expect(accounts).toHaveLength(1)
  })

  test("Save button is disabled while the key field is empty", async ({ page }) => {
    await page.goto("/settings?section=subscription&subTab=opencode")

    await page.getByRole("button", { name: "Add account" }).first().click()

    const dialog = page.getByRole("dialog", { name: /OpenCode-Zen subscription/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    const saveButton = dialog.getByRole("button", { name: /Save Zen key/i })
    await expect(saveButton).toBeDisabled()

    // Typing then clearing should re-disable.
    const keyField = dialog.getByLabel(/Zen API key/i)
    await keyField.fill("temporary")
    await expect(saveButton).toBeEnabled()
    await keyField.fill("")
    await expect(saveButton).toBeDisabled()
  })
})
