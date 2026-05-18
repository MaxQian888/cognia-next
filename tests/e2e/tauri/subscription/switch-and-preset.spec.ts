/**
 * Tauri E2E: multi-account switch + provider preset CRUD on the Anthropic tab.
 *
 * Seeds two Anthropic accounts directly via `subscription_save_account`, then
 * drives the AccountList switch button + PresetPicker dialog to verify both
 * the active-pointer flip and preset persistence round-trip through the
 * keyring-backed vault.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import {
  getActiveAccountId,
  readProviderPreset,
  resetSubscriptionState,
  seedAnthropicAccount,
  setActiveAccountId,
} from "../../helpers/subscription"

test.describe("tauri: Anthropic switch + preset", () => {
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

    // Both account rows render. Click the second row's switch button — it's
    // the <button> wrapping the email text. AccountList puts the email inside
    // the switch trigger, so a click on the email also flips active.
    const secondRow = page.getByRole("button").filter({ hasText: "e2e-second@example.com" }).first()
    await expect(secondRow).toBeVisible({ timeout: 10_000 })
    await secondRow.click()

    // The set-active call is async — wait for the IPC roundtrip to flip the
    // pointer. listAccountsForProvider is consistent with whatever Rust has.
    await expect
      .poll(async () => await getActiveAccountId(page, "anthropic"), { timeout: 10_000 })
      .toBe(idSecond)
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
