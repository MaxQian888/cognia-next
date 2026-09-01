/**
 * E2E: responsive layout sanity checks across Pixel 7 + iPhone 13 viewports.
 *
 * Behavioral-only — no screenshots. Asserts:
 *   - Each route renders without horizontal overflow.
 *   - The pair onboarding stays inside the safe-area on both viewports.
 *   - The accessibility tree exposes the primary CTAs.
 *
 * The same spec runs on both mobile projects via `playwright.config.ts`
 * project routing (`testDir: ./tests/e2e/mobile`).
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { resetCogniaDb, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

test.describe("mobile — responsive layout sanity", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    // `resetCogniaDb` clears `mobileRuntimeMode`, which parks the app on the
    // `/welcome` mode chooser — so `/workflows` below never reached its own
    // screen. Seeding a mode is the same pattern the other mobile specs use.
    await setCogniaSettings(page, { mobileRuntimeMode: "standalone" })
  })

  test("/pair renders without horizontal overflow", async ({ page }) => {
    await page.goto("/pair")
    await expect(page.getByTestId("pair-onboarding")).toBeVisible()

    const { docWidth, viewport } = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }))
    // Allow a 1px rounding tolerance.
    expect(docWidth).toBeLessThanOrEqual(viewport + 1)
  })

  test("/workflows renders with the New Workflow CTA reachable via role", async ({ page }) => {
    await page.goto("/workflows")
    // `workflow-create` never existed on the mobile surface — the toolbar ships
    // `mobile-workflow-new`. The old id made this assertion unfalsifiable.
    await expect(page.getByTestId("mobile-workflow-new")).toBeVisible()
    // The CTA must stay reachable as a button regardless of layout.
    await expect(page.getByTestId("mobile-workflow-new")).toHaveRole("button")
  })

  test("safe-area padding shape is applied on /pair", async ({ page }) => {
    await page.goto("/pair")
    const pad = await page.locator("[data-testid='pair-onboarding']").evaluate((el) => {
      const styles = window.getComputedStyle(el)
      return {
        paddingBottom: styles.paddingBottom,
        paddingTop: styles.paddingTop,
      }
    })
    // Bottom padding is computed from `env(safe-area-inset-bottom)` which
    // browsers without notch state report as 0. Either way the value must
    // be a positive pixel string (e.g., "16px").
    expect(pad.paddingBottom).toMatch(/\d+px/)
    expect(pad.paddingTop).toMatch(/\d+px/)
  })

  test("home route renders without crashing under a mobile viewport", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.locator("body")).toBeVisible()
    expect(errors).toEqual([])
  })
})

/**
 * Routes with NO platform branch.
 *
 * The bottom tab bar only exposes chat / workflows / discover / me, and `/me`
 * covers settings — but these routes stay reachable from deep links, in-chat
 * links, share-target hand-offs and notification taps. None of them calls
 * `usePlatform()`, and `DesktopAppShell` is a no-op on mobile, so whatever they
 * render is what the user gets, with no app chrome around it.
 *
 * The bar here is deliberately "not broken", not "designed for touch":
 *   - the route must not throw,
 *   - it must not scroll horizontally,
 *   - it must actually paint (the `h-full`-into-`min-h` collapse documented in
 *     `mobile-shell-wrapper.tsx` renders a blank strip below the top bar, which
 *     no overflow check would catch).
 */
const UNBRANCHED_ROUTES = [
  "/a2ui",
  "/sites",
  "/integrations",
  "/agent-runs",
  "/browser",
  "/logs?channel=traces&view=dashboard",
  "/source-control",
  "/workspace",
  "/skills",
  "/twin",
] as const

/**
 * Routes that redirect a compact layout somewhere phone-shaped instead of
 * rendering their desktop body at 375px. The assertion is the redirect: the
 * destination has its own tests, and leaving these in the list above would
 * check the wrong page while claiming they have no branch.
 */
const COMPACT_REDIRECTS: readonly (readonly [string, string])[] = [
  ["/scheduler", "/me/scheduler"],
] as const

test.describe("mobile — desktop routes reached on a phone", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    // Without a runtime mode the app parks on the `/welcome` mode chooser and
    // every navigation below would assert against the welcome screen instead of
    // the route under test. Standalone is the harsher of the two modes here —
    // no paired desktop to answer for anything these pages ask about.
    await setCogniaSettings(page, { mobileRuntimeMode: "standalone" })
  })

  for (const [from, to] of COMPACT_REDIRECTS) {
    test(`${from} sends a phone to ${to}`, async ({ page }) => {
      await page.goto(from, { waitUntil: "domcontentloaded" })
      await waitForTestGlobals(page, 30_000)
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(to)
    })
  }

  for (const route of UNBRANCHED_ROUTES) {
    test(`${route} survives a mobile viewport`, async ({ page }) => {
      const errors: string[] = []
      page.on("pageerror", (e) => errors.push(e.message))

      await page.goto(route, { waitUntil: "domcontentloaded" })
      await expect(page.locator("body")).toBeVisible()
      // A static-export navigation is a full page load: the shell has to boot
      // and hydrate again. Measuring straight after `goto` reads a pre-hydration
      // DOM and reports "painted nothing" for every route, broken or not.
      await waitForTestGlobals(page, 30_000)
      // Then give the route's own render a bounded chance to produce a box.
      // Polling (rather than a fixed wait) keeps a healthy route fast while
      // still letting a genuinely blank one fail.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const shell = document.querySelector("[data-testid='mobile-shell-wrapper']")
              if (!shell) return 0
              return Array.from(shell.querySelectorAll("*")).reduce(
                (tallest, el) =>
                  Math.max(tallest, (el as HTMLElement).getBoundingClientRect().height),
                0
              )
            }),
          { message: `${route} never painted`, timeout: 15_000 }
        )
        .toBeGreaterThan(0)

      const metrics = await page.evaluate(() => {
        const shell = document.querySelector("[data-testid='mobile-shell-wrapper']")
        // Height of the tallest painted element under the shell — 0 means the
        // page collapsed rather than rendered.
        // `reduce`, not `Math.max(...array)` — these pages can carry thousands
        // of elements and spreading them overflows the argument limit.
        const painted = shell
          ? Array.from(shell.querySelectorAll("*")).reduce(
              (tallest, el) => Math.max(tallest, (el as HTMLElement).getBoundingClientRect().height),
              0
            )
          : 0
        return {
          docWidth: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          painted,
        }
      })

      expect(errors, `${route} threw during render`).toEqual([])
      expect(metrics.docWidth, `${route} scrolls horizontally`).toBeLessThanOrEqual(
        metrics.viewport + 1
      )
      expect(metrics.painted, `${route} painted nothing`).toBeGreaterThan(0)
    })
  }
})
