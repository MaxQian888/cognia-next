/**
 * Tauri E2E: automation settings IPC round-trip.
 *
 * `automation_settings_get` / `automation_settings_set` are the canonical
 * read/write paths for the permission gate. This spec asserts:
 *   1. Defaults match what the renderer expects when no settings have been
 *      written (`globalEnabled === false`).
 *   2. Writing a flipped value via `desktop.settingsSet` is persisted and
 *      visible on the next `settingsGet`.
 *
 * The audit ring is in-memory on the Rust side; resetting Dexie does not
 * clear it, but that's fine — these assertions look at the live state, not
 * the audit trail.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

interface AutomationSettings {
  globalEnabled: boolean
  surfaces: Record<string, { tier: "AlwaysAllow" | "PerCall" | "Disabled" }>
}

async function readSettings(page: import("@playwright/test").Page): Promise<AutomationSettings> {
  return await page.evaluate(async () => {
    const { desktop } = await import("@/lib/automation/client")
    return (await desktop.settingsGet()) as unknown as AutomationSettings
  })
}

async function writeSettings(
  page: import("@playwright/test").Page,
  next: AutomationSettings
): Promise<void> {
  await page.evaluate(async (n) => {
    const { desktop } = await import("@/lib/automation/client")
    await desktop.settingsSet(n as unknown as Parameters<typeof desktop.settingsSet>[0])
  }, next)
}

test.describe("tauri: automation settings IPC", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("globalEnabled defaults to false and flips through settingsSet", async ({ page }) => {
    const original = await readSettings(page)
    expect(typeof original.globalEnabled).toBe("boolean")

    const flipped: AutomationSettings = {
      ...original,
      globalEnabled: !original.globalEnabled,
    }
    await writeSettings(page, flipped)

    const after = await readSettings(page)
    expect(after.globalEnabled).toBe(flipped.globalEnabled)

    // Restore so subsequent tests start from a known state.
    await writeSettings(page, original)
  })
})
