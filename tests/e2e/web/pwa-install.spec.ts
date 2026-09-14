/**
 * E2E: PWA install surface (web shell).
 *
 * Runs in the static lane (`PLAYWRIGHT_STATIC=1`, `pnpm test:e2e:build` +
 * `pnpm test:e2e:static`) where the Serwist worker is actually emitted —
 * dev builds disable it, so this spec must live against `out/`.
 *
 * What a browser can and cannot prove here:
 *  - CAN: manifest link + fields, every manifest asset resolving, `sw.js`
 *    registering, the navigation offline fallback serving `offline.html`,
 *    the in-app install entry mounting on the web shell.
 *  - CANNOT: `beforeinstallprompt`. Headless Chromium never fires it, so the
 *    prompt flow is covered by jsdom suites (`hooks/use-install-prompt`,
 *    `InstallAppCard`) — not simulated here.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

const SW_READY_TIMEOUT = 60_000

/** Wait until Serwist's worker is installed, activated, and controlling. */
async function waitForServiceWorker(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker?.ready.then(() => true), undefined, {
    timeout: SW_READY_TIMEOUT,
  })
}

const REQUIRED_MANIFEST_FIELDS = ["id", "name", "display", "start_url", "icons"]

test.describe("PWA install surface", () => {
  test("serves an installable manifest with all declared assets reachable", async ({ page }) => {
    const response = await page.goto("/manifest.webmanifest")
    expect(response?.ok()).toBe(true)

    const manifest = (await response?.json()) as Record<string, unknown>
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      expect(manifest[field], `manifest.${field}`).toBeTruthy()
    }
    expect(manifest.display).toBe("standalone")
    expect(manifest.scope).toBe("/")

    // Every asset the manifest advertises must resolve — a 404 inside the
    // install dialog is the silent failure this spec exists to catch.
    const assetUrls: string[] = []
    for (const icon of (manifest.icons ?? []) as { src: string }[]) assetUrls.push(icon.src)
    for (const shot of (manifest.screenshots ?? []) as { src: string }[]) {
      assetUrls.push(shot.src)
    }
    expect(assetUrls.length).toBeGreaterThan(0)
    for (const url of assetUrls) {
      const asset = await page.request.get(url)
      expect(asset.ok(), `manifest asset ${url}`).toBe(true)
    }

    // The HTML entry point links the manifest — without it nothing above is
    // ever discovered.
    await page.goto("/")
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      /manifest\.webmanifest/
    )
  })

  test("serves sw.js and the offline shell", async ({ page }) => {
    for (const url of ["/sw.js", "/offline.html"]) {
      const response = await page.request.get(url)
      expect(response.ok(), url).toBe(true)
    }
    const offlineHtml = await (await page.request.get("/offline.html")).text()
    expect(offlineHtml).toContain("offline")
  })

  test("registers the service worker and controls the page", async ({ page }) => {
    await page.goto("/")
    // Serwist's injected registration resolves `ready` once active; with
    // skipWaiting + clientsClaim the first load is already controlled.
    await waitForServiceWorker(page)
    const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller))
    expect(controlled).toBe(true)
  })

  test("serves the offline fallback for an uncached navigation while offline", async ({
    page,
    context,
  }) => {
    await page.goto("/")
    await waitForServiceWorker(page)

    await context.setOffline(true)
    // A route never visited this session has no runtime-cached HTML, so the
    // SW's document fallback must answer — not a browser error page.
    await page.goto("/inbox/all", { waitUntil: "domcontentloaded" })
    // The copy uses a typographic apostrophe — match on the heading role,
    // not the literal text.
    await expect(page.getByRole("heading", { name: /offline/i })).toBeVisible()

    await context.setOffline(false)
    await page.goto("/")
    await expect(page.locator('link[rel="manifest"]')).toBeAttached()
  })

  test("shows the install card on the web shell's About section", async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/")
    await waitForTestGlobals(page, 30_000)
    // A seeded account is a first run — without a settled record
    // `OnboardingGate` bounces `/settings` to `/onboarding` before the shell
    // can render the section at all.
    await setCogniaSettings(page, {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-09-07T00:00:00.000Z",
      },
    })
    await page.goto("/settings?section=about")
    // In headless Chromium the prompt never arrives, so the card shows its
    // `unavailable` body — the assertion is that the entry mounted at all.
    await expect(page.getByTestId("install-app-card")).toBeVisible()
  })
})
