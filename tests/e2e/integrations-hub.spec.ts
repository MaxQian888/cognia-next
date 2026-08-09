import { expect, test } from "@/tests/e2e/fixtures/test"
import {
  ensureCogniaAccount,
  waitForPluginRuntimeReady,
  waitForTestGlobals,
} from "./helpers/db-reset"

test.describe("Integrations Hub", () => {
  test("renders the host-owned management surface without a platform built-in", async ({
    page,
  }) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.goto("/", { waitUntil: "domcontentloaded" })
      await ensureCogniaAccount(page)
      await page.goto("about:blank")
      await page.goto("/integrations", { waitUntil: "domcontentloaded" })
      await waitForTestGlobals(page, 30_000)
      await waitForPluginRuntimeReady(page, 30_000)
      if (await page.getByRole("heading", { name: "Integrations" }).isVisible()) break
    }

    await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText("Integration management requires the desktop app.")).toBeVisible()
    await expect(
      page.getByText("Install an Integration-capable Marketplace plugin to begin.")
    ).toBeVisible()
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Subscriptions" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Approvals and jobs" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible()
  })
})
