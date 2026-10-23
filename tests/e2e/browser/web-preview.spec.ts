import { test, expect } from "@/tests/e2e/fixtures/test"
import { ensureAppMounted, setCogniaSettings } from "../helpers/db-reset"
import { startExternalServiceFixture } from "../fixtures/external-service-site/server"
import { createMockCompanionServer } from "../mobile/mock-v2-server"
import { provisionMockCompanionConfig } from "../mobile/companion-fixture"

// This route's browser-only contract needs its own spec: desktop/native browser
// suites cannot prove that an unpaired static Web client can reach the preview.
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL })

test.describe("standalone Web browser preview", () => {
  let site: Awaited<ReturnType<typeof startExternalServiceFixture>>
  test.beforeAll(async () => {
    site = await startExternalServiceFixture()
  })
  test.afterAll(async () => {
    await site.close()
  })
  test.beforeEach(async ({ page }) => {
    await page.goto("/browser", { waitUntil: "domcontentloaded" })
    // Each test owns a fresh browser context. Keep its live encrypted account
    // instead of deleting a database while the plugin runtime is using it.
    await ensureAppMounted(page)
    await setCogniaSettings(page, {
      remoteBrowserEnabled: false,
      browserDefaultBackend: "embedded",
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-10-22T00:00:00.000Z",
      },
    })
    // A fresh static artifact can redirect to onboarding before the settings
    // seed. Restore the requested route only after that seed has completed.
    if (new URL(page.url()).pathname !== "/browser") {
      await page.goto("/browser", { waitUntil: "domcontentloaded" })
      await ensureAppMounted(page)
    }
  })

  test("@smoke opens an actual iframe and exposes the shared engine selector", async ({ page }) => {
    const input = page.getByRole("textbox", { name: "http://localhost:3000" })
    await expect(input).toBeVisible()
    await input.fill(`${site.origin}/frame`)
    await input.press("Enter")
    const frame = page.frameLocator('iframe[title="Web page preview"]')
    await frame.getByRole("textbox", { name: "Frame note" }).fill("Web preview works")
    await frame.getByRole("button", { name: "Save frame" }).click()
    await expect(frame.locator("body")).toHaveAttribute("data-saved", "true")
    await input.fill(`${site.origin}/changed`)
    await input.press("Enter")
    await expect(frame.getByRole("heading", { name: "Redesigned dashboard" })).toBeVisible()
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(input).toHaveValue(`${site.origin}/frame`)
    await expect(frame.getByRole("textbox", { name: "Frame note" })).toBeVisible()
    await page.getByRole("button", { name: "More browser actions" }).click()
    await expect(page.getByRole("combobox", { name: "Browser engine" })).toBeVisible()
    await page.screenshot({
      path: ".cache/browser-web-access/web-preview.png",
      fullPage: true,
      animations: "disabled",
    })
  })

  test("keeps a framing-denied URL available for manual recovery and external open", async ({
    page,
    context,
  }) => {
    const blocked = `${site.origin}/framing-denied`
    await context.route(blocked, (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-security-policy": "frame-ancestors 'none'",
        },
        body: "<h1>Framing denied fixture</h1>",
      })
    )
    const input = page.getByRole("textbox", { name: "http://localhost:3000" })
    const refusedFrame = page.waitForEvent("console", {
      predicate: (message) => /frame-ancestors|refused to frame/i.test(message.text()),
    })
    await input.fill(blocked)
    await input.press("Enter")
    await refusedFrame
    await expect(
      page
        .frameLocator('iframe[title="Web page preview"]')
        .getByRole("heading", { name: "Framing denied fixture" })
    ).not.toBeVisible()
    await expect(page.locator('iframe[title="Web page preview"]')).toHaveAttribute("src", blocked)
    await page.getByRole("button", { name: "Trouble viewing this page?" }).click()
    const recovery = page.getByRole("alert").filter({ hasText: blocked })
    await expect(recovery).toContainText(blocked)
    const popupPromise = page.waitForEvent("popup")
    await recovery.getByRole("button", { name: "Open in external browser" }).click()
    const popup = await popupPromise
    await expect(popup).toHaveURL(blocked)
    await expect(popup.getByRole("heading", { name: "Framing denied fixture" })).toBeVisible()
    await popup.close()
    await recovery.getByRole("button", { name: "Try again", exact: true }).click()
    await expect(recovery).toBeHidden()
    await expect(input).toHaveValue(blocked)
  })

  test("switches to an unavailable cloud engine and recovers the same URL in the built-in preview", async ({
    page,
  }) => {
    // Reuse the pairing fixture's real DPoP flow. Its host deliberately offers
    // no browser capability, so setup must fail before creating an engine.
    const companion = createMockCompanionServer()
    await companion.start()
    try {
      const config = await provisionMockCompanionConfig(companion.baseUrl)
      await page.evaluate(async (value) => window.__cogniaSaveCompanionConfig!(value), {
        ...config,
        devicePrivateKeyJwk: config.devicePrivateKeyJwk!,
        deviceKeyThumbprint: config.deviceKeyThumbprint!,
      })
      await setCogniaSettings(page, { remoteBrowserEnabled: true })
      const target = `${site.origin}/frame`
      const input = page.getByRole("textbox", { name: "http://localhost:3000" })
      // Pairing changes the settings owner. Explicitly choose this pane's
      // preview rather than depending on a local default on the new host.
      await page.getByRole("button", { name: "More browser actions" }).click()
      await page.getByRole("combobox", { name: "Browser engine" }).click()
      await page.getByRole("option", { name: "Built-in preview", exact: true }).click()
      await page.keyboard.press("Escape")
      await input.fill(target)
      await input.press("Enter")
      await expect(
        page
          .frameLocator('iframe[title="Web page preview"]')
          .getByRole("textbox", { name: "Frame note" })
      ).toBeVisible()
      await input.fill("https://unsubmitted.example/")
      await page.getByRole("button", { name: "More browser actions" }).click()
      await page.getByRole("combobox", { name: "Browser engine" }).click()
      await page.getByRole("option", { name: "Cloud browser", exact: true }).click()
      const recovery = page.getByRole("alert").filter({ hasText: target })
      await expect(recovery).toBeVisible()
      await expect(page.locator('iframe[title="Web page preview"]')).toHaveCount(0)
      await page.screenshot({
        path: ".cache/browser-web-access/remote-recovery.png",
        fullPage: true,
        animations: "disabled",
      })
      await recovery.getByRole("button", { name: "Try again", exact: true }).click()
      await expect(recovery).toBeVisible()
      expect(companion.rpcCalls.some((call) => call.command === "browser_session_ensure")).toBe(
        false
      )
      await recovery.getByRole("button", { name: "Built-in preview", exact: true }).click()
      await expect(input).toHaveValue(target)
      await expect(
        page
          .frameLocator('iframe[title="Web page preview"]')
          .getByRole("textbox", { name: "Frame note" })
      ).toBeVisible()
    } finally {
      await companion.stop()
    }
  })
})
