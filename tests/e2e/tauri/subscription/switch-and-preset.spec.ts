/**
 * Tauri E2E: multi-account lifecycle + provider preset CRUD on the Anthropic tab.
 *
 * Seeds two Anthropic accounts directly via `subscription_save_account`, then
 * drives AccountList switch/remove actions + the PresetPicker dialog to verify
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

    await page.goto("/settings?section=subscription&subTab=anthropic")

    // Both account rows render. Activate the second account through the
    // accessible radio-style action owned by that row.
    const secondRow = page.locator("li").filter({ hasText: "e2e-second@example.com" })
    await expect(secondRow).toBeVisible({ timeout: 10_000 })
    await secondRow.getByRole("button", { name: "Set active" }).click()

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

    await page.goto("/settings?section=subscription&subTab=anthropic")

    const accountRow = page.locator("li").filter({ hasText: "e2e-remove@example.com" })
    await expect(accountRow).toBeVisible({ timeout: 10_000 })
    await accountRow.locator('button[aria-haspopup="menu"]').click()
    await page.getByRole("menuitem", { name: "Remove" }).click()

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
    await expect(
      page.getByText("No accounts yet. Add one to start using this provider.")
    ).toBeVisible()
  })

  test("preset CRUD round-trips through the keyring vault", async ({ page }) => {
    const id = await seedAnthropicAccount(page, {
      email: "e2e-preset@example.com",
      label: "preset-user",
    })
    await setActiveAccountId(page, "anthropic", id)

    await page.goto("/settings?section=subscription&subTab=anthropic")

    // Add preset.
    await page.getByRole("button", { name: /Add preset/i }).click()
    const editor = page.getByRole("dialog", { name: /Add preset/i })
    await expect(editor).toBeVisible({ timeout: 10_000 })

    await editor.getByLabel(/^Label$/i).fill("E2E Bedrock")
    await editor.getByLabel(/Base URL/i).fill("https://bedrock-runtime.e2e.example.com/v1")
    await editor.getByRole("button", { name: /^Save$/i }).click()
    await expect(editor).toBeHidden({ timeout: 10_000 })

    // Assert via transport that the preset landed.
    const saved = await readProviderPreset(page, "anthropic")
    expect(saved).not.toBeNull()
    expect(saved!.label).toBe("E2E Bedrock")
    expect(saved!.baseUrl).toBe("https://bedrock-runtime.e2e.example.com/v1")

    // Remove preset.
    await page.getByRole("button", { name: /Remove preset/i }).click()
    await expect
      .poll(async () => await readProviderPreset(page, "anthropic"), { timeout: 10_000 })
      .toBeNull()
  })
})
