/** Native-only automation fixture. All imports execute in the app bundle. */
import { test as base, expect } from "../fixtures"
import type { AutomationSettings } from "@/lib/automation/client"

export const test = base.extend<{ automationSettings: AutomationSettings }>({
  automationSettings: async ({ page }, provide) => {
    await page.goto("/")
    await page.waitForFunction(() => Boolean(window.__cogniaE2EAutomation))
    // The bridge mounts above AccountGate; consent belongs to the actual
    // unlocked shell. This marker does not prove async listener readiness.
    await expect(page.locator("body")).toHaveAttribute("data-app-shell", "true")
    await page.bringToFront()
    const original = await page.evaluate(async () => ({
      settings: await window.__cogniaE2EAutomation!.settingsGet(),
      killed: await window.__cogniaE2EAutomation!.killSwitchEngaged(),
    }))
    try {
      await provide(original.settings)
    } finally {
      await page.evaluate(async (snapshot) => {
        const api = window.__cogniaE2EAutomation!
        // Clear only this test's temporary grants, then restore both policy
        // and emergency state, including an initially disabled master flag.
        await api.killSwitch()
        await api.setEnabled(true)
        await api.settingsSet(snapshot.settings)
        if (snapshot.killed) await api.killSwitch()
      }, original)
    }
  },
})

export { expect }
