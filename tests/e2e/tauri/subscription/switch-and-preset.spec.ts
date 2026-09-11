/**
 * Tauri E2E: multi-account lifecycle + provider preset CRUD on the Anthropic tab.
 *
 * Seeds two Anthropic accounts directly via `subscription_save_account`, then
 * drives Account Center switch/remove actions + the PresetPicker dialog to verify
 * active-pointer changes, credential deletion, and preset persistence through
 * the keyring-backed vault.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import {
  getActiveAccountId,
  listAccountsForProvider,
  readProviderPreset,
  resetSubscriptionState,
  seedAnthropicAccount,
  setActiveAccountId,
} from "../../helpers/subscription"

test.describe("tauri: Anthropic account lifecycle + preset", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await resetSubscriptionState(page)
  })

  test("active pointer flips when the user clicks a different account row", async ({ page }) => {
    const idFirst = await seedAnthropicAccount(page, {
      email: "e2e-first@example.com",
      label: "first",
    })
    const idSecond = await seedAnthropicAccount(page, {
      email: "e2e-second@example.com",
      label: "second",
    })
    await setActiveAccountId(page, "anthropic", idFirst)

    await page.goto("/settings?section=subscription&subTab=accounts")

    // Selecting a row opens its detail panel; activation is a separate action.
    const secondRow = page.getByTestId(`account-center-row-anthropic-${idSecond}`)
    await expect(secondRow).toBeVisible({ timeout: 10_000 })
    await secondRow.click()
    await page.getByRole("button", { name: "Activate now", exact: true }).click()

    // The set-active call is async — wait for the IPC roundtrip to flip the
    // pointer. listAccountsForProvider is consistent with whatever Rust has.
    await expect
      .poll(async () => await getActiveAccountId(page, "anthropic"), { timeout: 10_000 })
      .toBe(idSecond)
  })

  test("removing the active account clears the vault entry and active pointer", async ({
    page,
  }) => {
    const id = await seedAnthropicAccount(page, {
      email: "e2e-remove@example.com",
      label: "remove-me",
    })
    await setActiveAccountId(page, "anthropic", id)

    await page.goto("/settings?section=subscription&subTab=accounts")

    const accountRow = page.getByTestId(`account-center-row-anthropic-${id}`)
    await expect(accountRow).toBeVisible({ timeout: 10_000 })
    await accountRow.click()
    await page.getByRole("button", { name: "More account actions" }).click()
    await page.getByRole("menuitem", { name: "Remove from Cognia" }).click()

    const dialog = page.getByRole("dialog", { name: "Remove this account?" })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    await expect
      .poll(async () => await listAccountsForProvider(page, "anthropic"), { timeout: 10_000 })
      .toEqual([])
    await expect
      .poll(async () => await getActiveAccountId(page, "anthropic"), { timeout: 10_000 })
      .toBeNull()
    await expect(page.getByText("No accounts match this filter.")).toBeVisible()
  })

  test("preset CRUD round-trips through the keyring vault", async ({ page }) => {
    const id = await seedAnthropicAccount(page, {
      email: "e2e-preset@example.com",
      label: "preset-user",
    })
    await setActiveAccountId(page, "anthropic", id)

    await page.goto("/settings?section=subscription&subTab=claude")

    // Add preset.
    await page.getByRole("button", { name: /Add preset/i }).click()
    const editor = page.getByRole("dialog", { name: /Add preset/i })
    await expect(editor).toBeVisible({ timeout: 10_000 })

    await editor.getByLabel(/^Label$/i).fill("E2E Bedrock")
    await editor.getByLabel(/Base URL/i).fill("https://bedrock-runtime.e2e.example.com/v1")
    await editor.getByRole("button", { name: /^Save preset$/i }).click()
    await expect(editor).toBeHidden({ timeout: 10_000 })

    // New library entries become effective only after the explicit default action.
    await page.getByRole("button", { name: "Set default", exact: true }).click()
    await expect
      .poll(async () => await readProviderPreset(page, "anthropic"), { timeout: 10_000 })
      .toMatchObject({
        label: "E2E Bedrock",
        baseUrl: "https://bedrock-runtime.e2e.example.com/v1",
      })

    // Remove preset.
    await page.getByRole("button", { name: /Remove preset/i }).click()
    const confirmation = page.getByRole("alertdialog", { name: "Remove this preset?" })
    await confirmation.getByRole("button", { name: "Remove preset", exact: true }).click()
    await expect(confirmation).toBeHidden()
    await expect
      .poll(async () => await readProviderPreset(page, "anthropic"), { timeout: 10_000 })
      .toBeNull()
  })
})
