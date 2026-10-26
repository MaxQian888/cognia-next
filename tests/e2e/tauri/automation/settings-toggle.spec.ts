/** Real settings IPC round-trip; preserves the operator's policy and kill state. */
import { test, expect } from "./fixtures"

test("enabled and perSurface round-trip without resuming the kill switch", async ({
  page,
  automationSettings,
}) => {
  const next = {
    ...automationSettings,
    enabled: !automationSettings.enabled,
    perSurface: {
      ...automationSettings.perSurface,
      workflow: { ...automationSettings.perSurface.workflow, tier: "perCall" as const },
    },
  }
  await page.evaluate(async (settings) => {
    await window.__cogniaE2EAutomation!.settingsSet(settings)
  }, next)
  expect(await page.evaluate(() => window.__cogniaE2EAutomation!.settingsGet())).toEqual(next)

  await page.evaluate(() => window.__cogniaE2EAutomation!.killSwitch())
  await page.evaluate(async (settings) => {
    await window.__cogniaE2EAutomation!.settingsSet({ ...settings, enabled: true })
  }, next)
  expect(await page.evaluate(() => window.__cogniaE2EAutomation!.killSwitchEngaged())).toBe(true)
  await page.evaluate(() => window.__cogniaE2EAutomation!.setEnabled(true))
  expect(await page.evaluate(() => window.__cogniaE2EAutomation!.killSwitchEngaged())).toBe(false)
})
