/**
 * Mobile E2E: a paired phone whose Host does not answer, on a conversation
 * with history.
 *
 * Three surfaces used to report that one state at once: the shell's offline
 * banner ("Reconnecting…"), the route's read-only Alert, and the chat's
 * "Waiting for your host" card above the transcript. With history the chat
 * now reports it as one line docked on the composer, and the two generic
 * bands stand down while it does (`lib/runtime/connection-notice-claim.ts`).
 *
 * The same screen pins the phone's message action bars: with the long-press
 * sheet as every row's action host, only the latest settled reply keeps an
 * inline bar.
 *
 * The device is genuinely paired with the mock Companion, then the Host is
 * taken off the network (every HTTP request refused, every socket closed) —
 * a desktop that went to sleep — so the runtime gate, the snapshot and the
 * banners all run for real against an unreachable Host.
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
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for the chat runtime strip E2E")
  return baseUrl
}

test.describe("mobile — chat while the paired Host is unreachable", () => {
  test("reports the Host once, on the composer, and keeps one action bar", async ({
    page,
  }, testInfo) => {
    // Four full app boots (onboarding bootstrap, paired boot, cold reload over
    // the seed, then the chat) — past the mobile project's 90s on a dev server.
    test.setTimeout(180_000)
    const baseUrl = mockV2BaseUrl()
    const companionConfig = await provisionMockCompanionConfig(baseUrl, "device-e2e-runtime-strip")
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

    // The Host goes away: the phone's network is fine, nothing answers it.
    const host = new URL(baseUrl)
    await page.route(`${baseUrl}/**`, (route) => route.abort("connectionrefused"))
    await page.routeWebSocket(
      (url) => url.host === host.host,
      (ws) => ws.close({ code: 1006, reason: "host unreachable" })
    )

    // A fresh load, as the other paired specs do after the bootstrap.
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-nav-trigger")).toBeVisible({ timeout: 30_000 })
    await waitForTestGlobals(page)

    // Seeded only now: a paired boot switches to the Host-scoped database, so a
    // conversation written before it would sit in a database the shell no
    // longer reads.
    const { sessionId } = await page.evaluate(async () => {
      if (!window.__cogniaSeedConversation) throw new Error("seed bridge unavailable")
      return window.__cogniaSeedConversation({ turns: 3, title: "Runtime strip" })
    })
    // Boot again over the seeded rows. Seeding writes under a live shell, and a
    // write that lands while the session's history read is in flight gets that
    // read discarded as superseded (`use-sessions.ts`); a cold boot reads the
    // rows the way a returning user's app does.
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-nav-trigger")).toBeVisible({ timeout: 30_000 })

    // Opened the way a phone user opens one: from the conversation drawer.
    await page.getByTestId("mobile-nav-trigger").click()
    await page.getByTestId(`mobile-channel-row-${sessionId}`).click()

    await expect(page.getByText("Answer number 1.", { exact: false })).toBeVisible({
      timeout: 30_000,
    })

    // One line on the composer's top edge, with the way out on it.
    const strip = page.getByTestId("chat-runtime-strip")
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await expect(strip).toHaveAttribute("role", "status")
    await expect(page.getByTestId("chat-runtime-strip-action")).toHaveText("Settings")
    expect((await strip.boundingBox())!.height).toBeLessThanOrEqual(36)

    // ...and nothing else saying the same thing.
    await expect(page.getByTestId("chat-runtime-notice")).toHaveCount(0)
    // The shell banner stands down entirely: the strip reports the Host AND
    // the outbound queue (writes the Host refused while it was away).
    await expect(page.getByTestId("offline-banner")).toHaveCount(0)
    // Neither the banner's band nor the route boundary's read-only band.
    await expect(page.getByTestId("runtime-status-band")).toHaveCount(0)

    // The composer says why it is off, not "pick a conversation".
    await expect(page.getByPlaceholder("You can send once the host reconnects")).toBeDisabled()

    // Three turns, one inline action bar: the latest reply's.
    await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(1)

    const shot = testInfo.outputPath("runtime-strip.png")
    await page.screenshot({ path: shot })
    await testInfo.attach("runtime-strip", { path: shot, contentType: "image/png" })
  })
})
