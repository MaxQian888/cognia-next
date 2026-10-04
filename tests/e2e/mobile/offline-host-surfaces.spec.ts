/**
 * Mobile E2E: the tab hubs of a paired phone whose Host does not answer.
 *
 * Before this, three things went wrong at once on that phone:
 *  - Me and Discover — declared `offline: "local"` — rendered a full-page
 *    "Host offline" wall, so the connection settings were behind the page
 *    that said the connection was down;
 *  - Workflows stacked two bands ("Reconnecting…" and "Read-only mode: …")
 *    and its list shrank to ~80% of the screen inside the boundary's flex row;
 *  - a page blocked for being offline said "Host offline" under a banner
 *    saying "Reconnecting…".
 *
 * Same real pairing as `chat-runtime-strip.spec.ts`: paired with the mock
 * Companion, then the Host is taken off the network.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile, waitForTestGlobals } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import {
  companionConfigSecureStorage,
  provisionMockCompanionConfig,
} from "./companion-fixture"

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for the offline host surfaces E2E")
  return baseUrl
}

test.describe("mobile — tab hubs while the paired Host is unreachable", () => {
  test("one connection band, settings reachable, pages at full width", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000)
    const baseUrl = mockV2BaseUrl()
    const companionConfig = await provisionMockCompanionConfig(baseUrl, "device-e2e-offline-hubs")
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
      secureStorage: companionConfigSecureStorage(companionConfig),
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired", {
      onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-07T00:00:00.000Z" },
    })
    await waitForTestGlobals(page)

    const host = new URL(baseUrl)
    await page.route(`${baseUrl}/**`, (route) => route.abort("connectionrefused"))
    await page.routeWebSocket(
      (url) => url.host === host.host,
      (ws) => ws.close({ code: 1006, reason: "host unreachable" })
    )

    // --- Workflows: one band that says both halves, list at full width -----
    await page.goto("/workflows", { waitUntil: "domcontentloaded" })
    const list = page.getByTestId("mobile-workflow-list")
    await expect(list).toBeVisible({ timeout: 30_000 })
    const banner = page.getByTestId("offline-banner")
    await expect(banner).toBeVisible({ timeout: 30_000 })
    await expect(banner).toContainText("cached data only")
    await expect(page.getByTestId("offline-banner-recovery")).toHaveText("Connection")
    // The boundary no longer adds a second band under the banner.
    await expect(page.getByTestId("runtime-status-band")).toHaveCount(1)
    const viewport = page.viewportSize()!
    const listBox = (await list.boundingBox())!
    expect(listBox.width).toBeGreaterThanOrEqual(viewport.width - 1)
    // The title clears the band instead of touching it.
    const bannerBox = (await banner.boundingBox())!
    const titleBox = (await list.getByRole("heading", { level: 1 }).boundingBox())!
    expect(titleBox.y - (bannerBox.y + bannerBox.height)).toBeGreaterThanOrEqual(8)
    await testInfo.attach("workflows-offline", {
      body: await page.screenshot({ path: testInfo.outputPath("workflows-offline.png") }),
      contentType: "image/png",
    })

    // --- Me: the settings hub renders; the band says the Host is away -------
    await page.goto("/me", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("me-page")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("surface-unavailable")).toHaveCount(0)
    await expect(page.getByTestId("offline-banner")).toBeVisible()
    await expect(page.getByTestId("offline-banner")).not.toContainText("cached data only")
    await testInfo.attach("me-offline", {
      body: await page.screenshot({ path: testInfo.outputPath("me-offline.png") }),
      contentType: "image/png",
    })

    // --- A route that needs a live Host: the page is the one report --------
    await page.goto("/remote-sessions", { waitUntil: "domcontentloaded" })
    const blocked = page.getByTestId("surface-unavailable")
    await expect(blocked).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("offline-banner")).toHaveCount(0)
    await expect(blocked.getByRole("link", { name: "Connection settings" })).toHaveAttribute(
      "href",
      /\/pair\?mode=recover/
    )
    await testInfo.attach("remote-sessions-offline", {
      body: await page.screenshot({ path: testInfo.outputPath("remote-sessions-offline.png") }),
      contentType: "image/png",
    })
  })
})
