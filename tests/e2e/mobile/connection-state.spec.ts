/**
 * E2E: connection state badge + biometric-guarded sign-out.
 *
 * Pre-seeds a paired CompanionConfig so PairOnboardingClient renders
 * PairedStep immediately, then drives the biometric guard to verify both
 * the success path (clear config → onAfterSignOut → discover step) and
 * the failure path (biometric rejects → config preserved).
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { createMockCompanionServer, type MockCompanionServer } from "./mock-v2-server"
import {
  companionConfigSecureStorage,
  provisionMockCompanionConfig,
} from "./companion-fixture"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { resetCogniaDb } from "../helpers/db-reset"

let server: MockCompanionServer
const COMPANION_BOOK_KEY = "cognia.companion.hosts.v2"

test.beforeAll(async () => {
  server = createMockCompanionServer()
  await server.start(0)
})

test.afterAll(async () => {
  await server.stop()
})

test.beforeEach(async ({ page }) => {
  server.reset()
  server.setStatusResponse("ok")
  const config = await provisionMockCompanionConfig(server.baseUrl, "device-connection-state")
  await injectCapacitor(page, {
    platform: "android",
    biometricAvailable: true,
    secureStorage: companionConfigSecureStorage(config),
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
    }, COMPANION_BOOK_KEY)
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
    }, COMPANION_BOOK_KEY)
    expect(persisted).not.toBeNull()
  })
})
