/**
 * Tauri E2E: OpenCode-Zen paste-key add-account flow.
 *
 * Unlike the Anthropic OAuth / Codex Reuse flows, the Zen path is a direct
 * paste: the user copies an API key from opencode.ai/auth and pastes it.
 * The renderer just calls `opencode_save_zen_key` (Tauri command) which
 * writes the credential into the unified vault.
 *
 * Happy path: paste a key + custom base URL + explicit preset → save → binding survives reload.
 * Edge case: save button is disabled while the key field is empty.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import {
  listAccountsForProvider,
  readAccountPresetId,
  resetSubscriptionState,
} from "../../helpers/subscription"

test.describe("tauri: OpenCode-Zen paste key", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await resetSubscriptionState(page)
  })

  test("paste key with an explicit endpoint preset → account binding persists", async ({
    page,
  }) => {
    // Create a non-default preset so the assertion cannot pass via the provider fallback.
    await page.goto("/settings?section=subscription&subTab=opencode")
    await page.getByRole("button", { name: "Add preset", exact: true }).click()
    const editor = page.getByRole("dialog", { name: "Add preset", exact: true })
    await editor.getByLabel("Label", { exact: true }).fill("E2E OpenCode relay")
    await editor.getByLabel("Base URL", { exact: true }).fill("https://zen-relay.example.com/v1")
    await editor.getByRole("button", { name: "Save preset", exact: true }).click()
    await expect(editor).toBeHidden()

    await page.goto("/settings?section=subscription&subTab=accounts")

    await page.getByRole("button", { name: "Add account", exact: true }).click()
    await page.getByRole("menuitem", { name: "OpenCode", exact: true }).click()

    const dialog = page.getByRole("dialog", { name: /OpenCode subscription key/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    await dialog.getByLabel(/Zen API key/i).fill("zen_e2e_test_key_xyz123")
    await dialog.getByLabel(/Base URL/i).fill("https://zen-mock.example.com/api")
    await dialog.getByLabel(/^Label/i).fill("e2e-opencode")
    const presetSelector = dialog.getByRole("combobox", {
      name: "Endpoint preset for this account",
    })
    await presetSelector.selectOption({ label: "E2E OpenCode relay" })
    const selectedPresetId = await presetSelector.inputValue()

    await dialog.getByRole("button", { name: /Save Zen key/i }).click()

    await expect(dialog).toBeHidden({ timeout: 10_000 })

    const accounts = await listAccountsForProvider(page, "opencode")
    expect(accounts).toHaveLength(1)
    const accountId = accounts[0].id
    await expect.poll(() => readAccountPresetId(page, "opencode", accountId)).toBe(selectedPresetId)
    await page.reload()
    await page.getByTestId(`account-center-row-opencode-${accountId}`).click()
    await expect(
      page.getByRole("combobox", { name: "Endpoint preset for this account" })
    ).toHaveText("E2E OpenCode relay")

    // Leave the shared native preset library clean for the next test.
    await page.goto("/settings?section=subscription&subTab=opencode")
    const presetRow = page.locator("li").filter({ hasText: "E2E OpenCode relay" })
    await presetRow.getByRole("button", { name: "Remove preset", exact: true }).click()
    const confirmation = page.getByRole("alertdialog", { name: "Remove this preset?" })
    await confirmation.getByRole("button", { name: "Remove preset", exact: true }).click()
    await expect(confirmation).toBeHidden()
  })

  test("Save button is disabled while the key field is empty", async ({ page }) => {
    await page.goto("/settings?section=subscription&subTab=accounts")

    await page.getByRole("button", { name: "Add account", exact: true }).click()
    await page.getByRole("menuitem", { name: "OpenCode", exact: true }).click()

    const dialog = page.getByRole("dialog", { name: /OpenCode subscription key/i })
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
