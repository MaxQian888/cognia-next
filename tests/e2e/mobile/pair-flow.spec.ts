/**
 * Wave 3.7 — Mobile pair flow.
 *
 * Smoke checks (existing) verify the three-step state machine renders. The
 * round-trip suite below drives the form against a canonical Companion mock,
 * exercises happy + error paths, and verifies that only the P-256 private
 * identities enter platform secure storage.
 *
 * Runs against both `mobile-pixel-7` (Chromium) and `mobile-iphone-13`
 * (WebKit) projects. The latter is opt-in — install with
 * `pnpx playwright install webkit`.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import {
  createMockCompanionServer,
  MOCK_COMPANION_HOST_ID,
  type MockCompanionServer,
} from "./mock-v2-server"
import { createOwnerPairPayload } from "./companion-fixture"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { bootstrapCogniaMobile } from "../helpers/db-reset"

let server: MockCompanionServer

test.beforeAll(async () => {
  server = createMockCompanionServer()
  await server.start(0)
})

test.afterAll(async () => {
  await server.stop()
})

test.beforeEach(async ({ page }) => {
  server.reset()
  // Inject Capacitor before any navigation so platform-detection picks the
  // mobile branch and SecureStorage backs companionStorage.
  await injectCapacitor(page, { platform: "android", pushToken: "e2e-pairing-push-token" })
  await page.goto("/")
  // Every test has a fresh browser context. Pairing is the subject here;
  // complete the independent first-run choice before opening its own route.
  await bootstrapCogniaMobile(page, "paired", {
    onboardingProgress: {
      version: 2,
      path: "completed",
      completedAt: "2026-01-01T00:00:00.000Z",
    },
  })
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
    await expect(page.getByTestId("pair-payload")).toBeVisible()
    await expect(page.getByTestId("pair-submit")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })

  test("rejects an invalid baseUrl with a recoverable error", async ({ page }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-payload").fill(
      createOwnerPairPayload("not-a-url")
    )
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

test.describe("mobile pair flow — cgnp3 + DPoP round-trip", () => {

  test("@smoke @critical happy path pairs and persists the device config", async ({
    page,
  }) => {
    server.setPairScenario({ kind: "ok", serverVersion: "9.9.9" })
    const pairPayload = createOwnerPairPayload(server.baseUrl)

    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-payload").fill(pairPayload)

    const pairPromise = server.waitForRegistration()
    await page.getByTestId("pair-submit").click()

    const payload = await pairPromise
    expect(payload.invitation).toMatch(/^e2e-owner-invitation-/)
    expect(payload.displayName.length).toBeGreaterThan(0)
    expect(payload.publicKeyPem).toContain("BEGIN PUBLIC KEY")
    expect(payload.signalingPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)

    // PairedStep replaces PairStep when onPaired is called.
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired", {
      timeout: 10_000,
    })

    const persisted = await page.evaluate(() =>
      (
        window as unknown as {
          __cogniaCapMock: { secureStorageSnapshot: () => Record<string, string> }
        }
      ).__cogniaCapMock.secureStorageSnapshot()
    )
    const publicBook = persisted["cognia.companion.hosts.v2"]
    expect(publicBook).toContain(server.baseUrl)
    expect(publicBook).toContain("9.9.9")
    expect(publicBook).not.toContain('"d"')
    expect(Object.values(JSON.parse(publicBook).hosts)).toEqual([
      expect.objectContaining({
        accountNamespace: "acct_e2e_seed_account",
        tenantId: "local_acct_a",
        hostId: MOCK_COMPANION_HOST_ID,
      }),
    ])
    expect(server.rpcCalls.some((call) => call.command === "host_feature_manifest")).toBe(true)
    expect(server.rpcCalls).toContainEqual(expect.objectContaining({
      command: "register_push_token",
      body: { token: "e2e-pairing-push-token", provider: "fcm" },
    }))
    const privateEntries = Object.entries(persisted).filter(([key]) =>
      key.includes("private-jwk")
    )
    expect(privateEntries).toHaveLength(2)
    expect(privateEntries.every(([, value]) => JSON.parse(value).d)).toBe(true)
  })

  test("discovery is public but the Host manifest requires device proof", async ({ request }) => {
    const health = await request.get(`${server.baseUrl}/healthz`)
    expect(health.status()).toBe(200)
    expect(await health.json()).toMatchObject({ server_id: MOCK_COMPANION_HOST_ID, advertised_port: server.port })
    const manifest = await request.post(`${server.baseUrl}/api/_rpc/host_feature_manifest`, { data: {} })
    expect(manifest.status()).toBe(401)
    expect(server.rpcCalls).toHaveLength(0)
  })

  test("an incompatible Host protocol cannot complete activation", async ({ page }) => {
    server.setHostProtocol({ min: 99, max: 99 })
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-payload").fill(createOwnerPairPayload(server.baseUrl))
    const registration = server.waitForRegistration()
    await page.getByTestId("pair-submit").click()
    await registration
    await expect(page.getByTestId("pair-error")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
    expect(server.rpcCalls.some((call) => call.command === "host_feature_manifest")).toBe(true)
  })

  test("expired Owner invitation: server returns 401 and leaves no paired target", async ({
    page,
  }) => {
    server.setPairScenario({
      kind: "expired",
      status: 401,
      message: "Pair JWT has expired.",
    })

    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-payload").fill(createOwnerPairPayload(server.baseUrl))
    await page.getByTestId("pair-submit").click()

    await expect(page.getByTestId("pair-error")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")

    const persisted = await page.evaluate(() =>
      (
        window as unknown as {
          __cogniaCapMock: { secureStorageSnapshot: () => Record<string, string> }
        }
      ).__cogniaCapMock.secureStorageSnapshot()
    )
    expect(persisted["cognia.companion.hosts.v2"]).toBeUndefined()
  })

  test("Host mismatch is rejected before device registration", async ({
    page,
  }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page
      .getByTestId("pair-payload")
      .fill(createOwnerPairPayload(server.baseUrl, { hostId: `${MOCK_COMPANION_HOST_ID}-other` }))

    await page.getByTestId("pair-submit").click()
    await expect(page.getByTestId("pair-error")).toBeVisible({ timeout: 5_000 })
    expect(server.registrationAttempts).toHaveLength(0)
  })

  test("server unreachable: connection drops, recoverable error appears", async ({ page }) => {
    server.setPairScenario({ kind: "unreachable" })

    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-payload").fill(createOwnerPairPayload(server.baseUrl))
    await page.getByTestId("pair-submit").click()

    await expect(page.getByTestId("pair-error")).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })
})
