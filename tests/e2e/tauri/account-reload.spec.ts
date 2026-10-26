/**
 * Cold account boot needs the real system webview and persisted IndexedDB.
 * Automation admission specs exercise an already-open shell; keep the full
 * document reload regression separate and leave native policy untouched.
 */
import { test, expect } from "./fixtures"

test("@critical cold reload reopens the account and interactive Workflows shell", async ({
  page,
}) => {
  test.setTimeout(180_000)
  await page.goto("/workflows", { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveAttribute("data-app-shell", "true", { timeout: 45_000 })
  await page.waitForFunction(() =>
    Boolean(
      window.__cogniaE2EAutomation && window.__cogniaE2ECompanion && window.__cogniaReadSessions
    )
  )
  const readPolicy = () =>
    page.evaluate(async () => ({
      settings: await window.__cogniaE2EAutomation!.settingsGet(),
      killed: await window.__cogniaE2EAutomation!.killSwitchEngaged(),
    }))
  const original = await readPolicy()
  const readAccount = () =>
    page.evaluate(async () => ({
      runtime: await window.__cogniaE2ECompanion!.runtime(),
      sessions: (await window.__cogniaReadSessions!()).map(({ id, database }) => ({
        id,
        database,
      })),
    }))
  const account = await readAccount()
  expect(account.runtime?.accountId).toBeTruthy()
  expect(account.runtime?.databaseName).toBeTruthy()

  for (let iteration = 0; iteration < 3; iteration++) {
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("body")).toHaveAttribute("data-app-shell", "true", {
      timeout: 45_000,
    })
    await expect(page.getByRole("heading", { name: /^(Workflows|工作流)$/ })).toBeVisible()
    await page.getByRole("button", { name: /^(Filter|筛选)$/ }).click()
    await expect(page.getByRole("menu")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toBeHidden()
    await page.waitForFunction(() =>
      Boolean(
        window.__cogniaE2EAutomation && window.__cogniaE2ECompanion && window.__cogniaReadSessions
      )
    )
    expect(await readPolicy()).toEqual(original)
    expect(await readAccount()).toEqual(account)
  }
})
