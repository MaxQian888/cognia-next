import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — shared AI chat", () => {
  test("@critical keeps conversion explicit and blocked while offline", async ({ page, context }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.addInitScript(() => {
      window.__cogniaCollabE2EContext = {
        orgId: "org_mobilee2e0000000000000",
        userId: "usr_mobilee2e0000000000000",
        baseUrl: "https://collab-mobile-e2e.test",
        accessToken: "ephemeral-mobile-token",
      }
    })
    await page.goto("/")
    await resetCogniaDb(page)

    const privateControls = page.getByRole("button", {
      name: "Open private conversation controls",
    })
    await expect(privateControls).toBeVisible({ timeout: 20_000 })

    await context.setOffline(true)
    await privateControls.click()
    await expect(page.getByText("Everyone invited later can read the full history")).toBeVisible()
    await expect(
      page.getByText(
        "Reconnect before converting. Messages and Agent runs are never queued silently."
      )
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Convert and share full history" })).toBeDisabled()
  })
})
