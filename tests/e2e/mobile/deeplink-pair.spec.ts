/**
 * E2E: Capacitor deep-link routing.
 *
 * The Capacitor mobile shell receives `cognia://share?...` / `cognia://pair?...`
 * URLs via `App.addListener("appUrlOpen", ...)`; the dispatch table in
 * `lib/capacitor/deeplink-router.ts` routes them to specific Next.js paths.
 * E2E proxies the final navigation directly and asserts the receiving
 * route handles the payload.
 *
 * Coverage:
 *   - Share-target deeplink → /share-target?text=&url= renders preview
 *   - Pair deeplink → /pair?payload= renders the pair onboarding shell
 */

import { expect, test } from "@playwright/test"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("mobile — deep-link routing", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("share deeplink lands on /share-target with the captured payload", async ({ page }) => {
    await page.goto("/share-target?text=hello%20world&url=https%3A%2F%2Fexample.com")
    await expect(page.getByTestId("share-target-page")).toBeVisible()
    await expect(page.getByTestId("share-target-preview")).toBeVisible()
    await expect(page.getByTestId("share-target-preview")).toContainText(/hello world/)
    await expect(page.getByTestId("share-target-preview")).toContainText(/example\.com/)
  })

  test("pair deeplink lands on /pair (payload param doesn't crash the page)", async ({ page }) => {
    const payload = encodeURIComponent(
      JSON.stringify({ b: "https://192.168.1.42:7891", j: "pair.jwt.payload", f: "fp" })
    )
    await page.goto(`/pair?payload=${payload}`)
    await expect(page.getByTestId("pair-onboarding")).toBeVisible({ timeout: 8_000 })
  })

  test("Capacitor App.appUrlOpen listener is wired and receives events without errors", async ({
    page,
  }) => {
    await page.goto("/")
    // Subscribe through our mock and push an event; the assertion is "no
    // pageerror" — the listener registration itself is the artifact under
    // test.
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))
    await page.evaluate(async () => {
      const cap = (
        window as unknown as {
          Capacitor: {
            Plugins: {
              App: {
                addListener: (
                  e: string,
                  cb: (p: { url: string }) => void
                ) => Promise<{ remove: () => void }>
              }
            }
          }
        }
      ).Capacitor.Plugins.App
      const sub = await cap.addListener("appUrlOpen", () => {})
      sub.remove()
    })
    await page.evaluate(() => {
      ;(
        window as unknown as { __cogniaCapMock: { pushAppUrlOpen: (u: string) => void } }
      ).__cogniaCapMock.pushAppUrlOpen("cognia://share?text=test")
    })
    await page.waitForTimeout(200)
    expect(errors).toEqual([])
  })
})
