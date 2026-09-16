/**
 * Contract (ADR-0182):
 * a browser with no paired host → `?section=image-catalog` deep link → the
 * settings shell refuses the section and says only a server deployment runs
 * it, without mounting the catalog (which would ask a host that is not there)
 * and without redirecting away from the address the user asked for.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

const SERVER_ONLY_BODY =
  "This section administers something only a Cognia server deployment runs. Pair a server that provides it, then open this section again."

test.describe("settings — runtime environment image catalog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    // A fresh profile reads as a first run; this spec is about Settings.
    await setCogniaSettings(page, { onboardingDismissedAt: Date.now() })
  })

  test("explains that the image catalog needs a server, and keeps the deep link", async ({
    page,
  }) => {
    await page.goto("/settings?section=image-catalog", { waitUntil: "domcontentloaded" })

    await expect(page.getByText("Not available on this host")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(SERVER_ONLY_BODY)).toBeVisible()
    // The desktop app cannot open it either, so the shell must not say so.
    await expect(page.getByText(/it needs the desktop app/)).toHaveCount(0)
    await expect(page.getByTestId("image-catalog-section")).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get("section")).toBe("image-catalog")
  })
})
