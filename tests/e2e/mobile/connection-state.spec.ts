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
import { resetCogniaDb } from "../helpers/db-reset"

let server: MockV2Server
const COMPANION_CONFIG_KEY = "cognia.companion.config.v1"

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
  await injectCapacitor(page, {
    platform: "android",
    biometricAvailable: true,
    secureStorage: {
      [COMPANION_CONFIG_KEY]: JSON.stringify({
        baseUrl: server.baseUrl,
        deviceJwt: "device.jwt.value",
        deviceId: "device_abc",
        serverVersion: "1.0.0",
      }),
    },
  })
  await page.goto("/")
  await resetCogniaDb(page)
})

test.describe("mobile — paired step + connection state", () => {
  test("seeded paired config renders the connection health card with badge", async ({ page }) => {
    await page.goto("/pair")
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired", {
      timeout: 10_000,
    })
    await expect(page.getByTestId("pair-paired-step")).toBeVisible()
    await expect(page.getByTestId("pair-health-card")).toBeVisible()
  })

  test("Refresh probe drives the health card to live when status OK", async ({ page }) => {
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
    await page.goto("/pair")
    await expect(page.getByTestId("pair-paired-step")).toBeVisible({ timeout: 10_000 })

    await page.getByTestId("pair-signout").click()

    // After sign-out the coordinator flips to the discover step.
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover", {
      timeout: 10_000,
    })
    const persisted = await page.evaluate((key) => {
      const mock = (
        window as unknown as {
          __cogniaCapMock: { secureStorageSnapshot: () => Record<string, string> }
        }
      ).__cogniaCapMock
      return mock.secureStorageSnapshot()[key] ?? null
    }, COMPANION_CONFIG_KEY)
    expect(persisted).toBeNull()
  })

  test("biometric-guarded sign-out blocked: error surfaces, storage preserved", async ({
    page,
  }) => {
    await page.goto("/pair")
    await expect(page.getByTestId("pair-paired-step")).toBeVisible({ timeout: 10_000 })

    // Keep biometrics available but fail verification so the guard blocks
    // instead of taking its intentional unavailable-device fallthrough.
    await page.evaluate(() => {
      ;(
        window as unknown as { __cogniaCapMock: { setBiometricVerify: (v: boolean) => void } }
      ).__cogniaCapMock.setBiometricVerify(false)
    })

    await page.getByTestId("pair-signout").click()

    await expect(page.getByTestId("pair-signout-error")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired")
    const persisted = await page.evaluate((key) => {
      const mock = (
        window as unknown as {
          __cogniaCapMock: { secureStorageSnapshot: () => Record<string, string> }
        }
      ).__cogniaCapMock
      return mock.secureStorageSnapshot()[key] ?? null
    }, COMPANION_CONFIG_KEY)
    expect(persisted).not.toBeNull()
  })
})
