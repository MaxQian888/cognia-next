/**
 * Wave 3.7 — Mobile pair flow.
 *
 * Smoke checks (existing) verify the three-step state machine renders. The
 * round-trip suite below drives the form against an Express mock V2 server
 * that simulates the real desktop response shape, exercises happy + error
 * paths, and verifies that `companionStorage` retains the device JWT.
 *
 * Runs against both `mobile-pixel-7` (Chromium) and `mobile-iphone-13`
 * (WebKit) projects. The latter is opt-in — install with
 * `pnpx playwright install webkit`.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { createMockV2Server, type MockV2Server } from "./mock-v2-server"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { resetCogniaDb } from "../helpers/db-reset"

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
  // Inject Capacitor before any navigation so platform-detection picks the
  // mobile branch and SecureStorage backs companionStorage.
  await injectCapacitor(page, { platform: "android" })
  await page.goto("/")
  await resetCogniaDb(page)
})

test.describe("mobile pair flow — UI state machine (existing smoke)", () => {
  test("lands on the discover step with a stepper visible", async ({ page }) => {
    await page.goto("/pair")
    await expect(page.getByTestId("pair-onboarding")).toBeVisible()
    await expect(page.getByTestId("pair-stepper")).toBeVisible()
    await expect(page.getByTestId("pair-discover-step")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover")
  })

  test("Skip to manual reveals the pair form", async ({ page }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await expect(page.getByTestId("pair-pair-step")).toBeVisible()
    await expect(page.getByTestId("pair-scan-qr")).toBeVisible()
    await expect(page.getByTestId("pair-baseurl")).toBeVisible()
    await expect(page.getByTestId("pair-jwt")).toBeVisible()
    await expect(page.getByTestId("pair-submit")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })

  test("rejects an invalid baseUrl with a recoverable error", async ({ page }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-baseurl").fill("not a url")
    await page.getByTestId("pair-jwt").fill("aaa.bbb.ccc")
    await page.getByTestId("pair-submit").click()
    await expect(page.getByTestId("pair-error")).toBeVisible()
  })

  test("Back button returns to the discover step", async ({ page }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-back-to-discover").click()
    await expect(page.getByTestId("pair-discover-step")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover")
  })
})

test.describe("mobile pair flow — V2 server round-trip", () => {
  const validJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0Iiwic2NwIjoicGFpciJ9.signature"

  test("@smoke @critical happy path pairs and persists the device config", async ({
    page,
  }) => {
    server.setPairScenario({ kind: "ok", body: { server_version: "9.9.9" } })
    server.setWhoamiFingerprint(null) // fingerprint attestation off

    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-baseurl").fill(server.baseUrl)
    await page.getByTestId("pair-jwt").fill(validJwt)

    const pairPromise = server.waitForPair()
    await page.getByTestId("pair-submit").click()

    const payload = await pairPromise
    expect(payload.pair_jwt).toBe(validJwt)
    expect(payload.device_label.length).toBeGreaterThan(0)

    // PairedStep replaces PairStep when onPaired is called.
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired", {
      timeout: 10_000,
    })

    // companionStorage retained the config — localStorage backend stores it
    // under "cognia.companion.config.v1".
    const persisted = await page.evaluate(() =>
      window.localStorage.getItem("cognia.companion.config.v1")
    )
    expect(persisted).not.toBeNull()
    const cfg = JSON.parse(persisted!)
    expect(cfg.baseUrl).toBe(server.baseUrl)
    expect(cfg.serverVersion).toBe("9.9.9")
  })

  test("expired pair JWT: server returns 401, error surfaces, no config written", async ({
    page,
  }) => {
    server.setPairScenario({
      kind: "expired",
      status: 401,
      message: "Pair JWT has expired.",
    })

    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-baseurl").fill(server.baseUrl)
    await page.getByTestId("pair-jwt").fill(validJwt)
    await page.getByTestId("pair-submit").click()

    await expect(page.getByTestId("pair-error")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")

    const persisted = await page.evaluate(() =>
      window.localStorage.getItem("cognia.companion.config.v1")
    )
    expect(persisted).toBeNull()
  })

  test("fingerprint mismatch: pair succeeds but attestation rejects, error surfaces", async ({
    page,
  }) => {
    const pinned = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const reported = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    server.setPairScenario({
      kind: "fingerprint-mismatch",
      pinnedFingerprint: pinned,
      bodyFingerprint: reported,
    })
    server.setWhoamiFingerprint(reported)

    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-baseurl").fill(server.baseUrl)
    await page.getByTestId("pair-jwt").fill(validJwt)

    // Inject a fingerprint into the form: there is no input for it, the UI
    // sets it via QR scan. Drive it via the Capacitor mock instead.
    await page.evaluate((fp) => {
      ;(
        window as unknown as { __cogniaCapMock: { setBarcodeResult: (s: string) => void } }
      ).__cogniaCapMock.setBarcodeResult(
        JSON.stringify({ b: window.location.origin, j: "aaa", f: fp })
      )
    }, pinned)

    await page.getByTestId("pair-submit").click()
    await expect(page.getByTestId("pair-error")).toBeVisible({ timeout: 5_000 })
  })

  test("server unreachable: connection drops, recoverable error appears", async ({ page }) => {
    server.setPairScenario({ kind: "unreachable" })

    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-baseurl").fill(server.baseUrl)
    await page.getByTestId("pair-jwt").fill(validJwt)
    await page.getByTestId("pair-submit").click()

    await expect(page.getByTestId("pair-error")).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })
})
