/**
 * Mobile E2E: Network settings read boundary (ADR-0056 D6).
 *
 * A paired phone owns its live connectivity read-out, while proxy mutation
 * remains desktop-only. Standalone mode must not expose this paired surface.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import {
  companionConfigSecureStorage,
  provisionMockCompanionConfig,
} from "./companion-fixture"

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for Network settings E2E")
  return baseUrl
}

test.describe("mobile — Network settings", () => {
  test("renders live device connectivity while keeping proxy configuration read-only", async ({
    page,
  }) => {
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      "device-e2e-network"
    )
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
      secureStorage: companionConfigSecureStorage(companionConfig),
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired")

    await page.goto("/me/network", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-network-page")).toBeVisible()
    await expect(page.getByTestId("network-status")).toContainText("Online")
    await expect(page.getByTestId("network-type")).toContainText("Wi-Fi")
    await expect(page.getByTestId("network-manage-note")).toBeVisible()
    await expect(page.getByTestId("me-section-network-proxy")).toBeVisible()
    await expect(page.getByTestId("mobile-network-page").getByRole("textbox")).toHaveCount(0)

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __cogniaCapMock: { getNetworkListenerCount: () => number }
              }
            ).__cogniaCapMock.getNetworkListenerCount()
        )
      )
      .toBeGreaterThan(0)

    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: {
            setNetwork: (status: { connected: boolean; connectionType: string }) => void
          }
        }
      ).__cogniaCapMock.setNetwork({ connected: false, connectionType: "none" })
    })
    await expect(page.getByTestId("network-status")).toContainText("Offline")
    await expect(page.getByTestId("network-type")).toContainText("No connection")

    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: {
            setNetwork: (status: { connected: boolean; connectionType: string }) => void
          }
        }
      ).__cogniaCapMock.setNetwork({ connected: true, connectionType: "cellular" })
    })
    await expect(page.getByTestId("network-status")).toContainText("Online")
    await expect(page.getByTestId("network-type")).toContainText("Cellular")
  })

  test("keeps Network settings gated in standalone mode", async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "standalone")

    await page.goto("/me/network", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-network-page")).toBeVisible()
    await expect(page.getByTestId("paired-only-placeholder")).toBeVisible()
    await expect(page.getByTestId("me-section-network-connectivity")).toHaveCount(0)
    await expect(page.getByTestId("network-manage-note")).toHaveCount(0)
  })
})
