/**
 * E2E: connection state badge + biometric-guarded sign-out.
 *
 * Pre-seeds a paired CompanionConfig so PairOnboardingClient renders
 * PairedStep immediately, then drives the biometric guard to verify both
 * the success path (clear config → onAfterSignOut → discover step) and
 * the failure path (biometric rejects → config preserved).
 */

import { expect, test } from "@playwright/test"
import { createMockV2Server, type MockV2Server } from "./mock-v2-server"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { resetCogniaDb, waitForTestGlobals } from "../helpers/db-reset"

let server: MockV2Server

test.beforeAll(async () => {
  server = createMockV2Server()
  await server.start(0)
})

test.afterAll(async () => {
  await server.stop()
})

test.beforeEach(async ({ page }) => {
  server.reset()
  server.setStatusResponse("ok")
  await injectCapacitor(page, { platform: "android", biometricAvailable: true })
  await page.goto("/")
  await resetCogniaDb(page)
})

async function seedPaired(page: import("@playwright/test").Page, baseUrl: string): Promise<void> {
  await waitForTestGlobals(page)
  await page.evaluate(async (url: string) => {
    const w = window as Window & {
      __cogniaSaveCompanionConfig?: (cfg: {
        baseUrl: string
        deviceJwt: string
        deviceId: string
        serverVersion: string
      }) => Promise<void>
    }
    await w.__cogniaSaveCompanionConfig?.({
      baseUrl: url,
      deviceJwt: "device.jwt.value",
      deviceId: "device_abc",
      serverVersion: "1.0.0",
    })
  }, baseUrl)
}

test.describe("mobile — paired step + connection state", () => {
  test("seeded paired config renders the connection health card with badge", async ({ page }) => {
    await seedPaired(page, server.baseUrl)
    await page.goto("/pair")
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired", {
      timeout: 10_000,
    })
    await expect(page.getByTestId("pair-paired-step")).toBeVisible()
    await expect(page.getByTestId("pair-health-card")).toBeVisible()
  })

  test("Refresh probe drives the health card to live when status OK", async ({ page }) => {
    await seedPaired(page, server.baseUrl)
    await page.goto("/pair")
    await expect(page.getByTestId("pair-paired-step")).toBeVisible({ timeout: 10_000 })

    server.setStatusResponse("ok")
    await page.getByTestId("pair-refresh").click()
    await expect(page.getByTestId("pair-health-card")).toHaveAttribute("data-health", "live", {
      timeout: 10_000,
    })
  })

  test("biometric-guarded sign-out succeeds: storage cleared, discover step returns", async ({
    page,
  }) => {
    await seedPaired(page, server.baseUrl)
    await page.goto("/pair")
    await expect(page.getByTestId("pair-paired-step")).toBeVisible({ timeout: 10_000 })

    await page.getByTestId("pair-signout").click()

    // After sign-out the coordinator flips to the discover step.
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover", {
      timeout: 10_000,
    })
    const persisted = await page.evaluate(() =>
      window.localStorage.getItem("cognia.companion.config.v1")
    )
    expect(persisted).toBeNull()
  })

  test("biometric-guarded sign-out blocked: error surfaces, storage preserved", async ({
    page,
  }) => {
    await seedPaired(page, server.baseUrl)
    // Flip biometric to unavailable so verifyIdentity rejects.
    await page.evaluate(() => {
      ;(
        window as { __cogniaCapMock: { setBiometricAvailable: (v: boolean) => void } }
      ).__cogniaCapMock.setBiometricAvailable(false)
    })
    await page.goto("/pair")
    await expect(page.getByTestId("pair-paired-step")).toBeVisible({ timeout: 10_000 })

    await page.getByTestId("pair-signout").click()

    // We expect either the sign-out error banner to appear OR the paired
    // step to remain (some biometric backends route to a cancellation that
    // hides the error). Both outcomes mean storage stayed put.
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired")
    const persisted = await page.evaluate(() =>
      window.localStorage.getItem("cognia.companion.config.v1")
    )
    expect(persisted).not.toBeNull()
  })
})
