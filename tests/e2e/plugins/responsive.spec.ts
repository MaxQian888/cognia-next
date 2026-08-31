/**
 * E2E: plugin workspace responsive layout + URL-driven navigation.
 *
 * Replaces a 60-test sweep (21% of the whole suite) that asserted the
 * PREVIOUS generation of this UI: a `?tab=` model with tabs that no longer
 * exist, Tailwind class strings (`lg:grid-cols-[200px_1fr]`,
 * `grid-cols-1 md:grid-cols-2`) that appear nowhere in the current tree,
 * dead-code assertions discarded via `void`, and tab checks that never
 * compared against the URL. Those tests passed with the CSS deleted and
 * failed on cosmetic renames — exactly inverted signal.
 *
 * The current workspace (components/plugins/plugin-panel.tsx) is a 3-pane
 * FeaturePageShell: nav sidebar / center pane / detail pane, driven by
 * `?section=` (+ `&gov=`), with legacy `?tab=` deep links translated via
 * router.replace. Desktop renders resizable panels; mobile collapses the
 * side panes into Sheet triggers. These tests measure THAT: real geometry,
 * real URL rewrites, real pane presence per breakpoint.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 375, height: 812 }

async function boot(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.goto("/")
  await resetCogniaDb(page)
}

test.describe("plugin workspace — desktop (1440)", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page, DESKTOP)
  })

  test("renders the 3-pane shell with real geometry", async ({ page }) => {
    await page.goto("/plugins?section=library", { waitUntil: "domcontentloaded" })
    const shell = page.getByTestId("feature-shell-plugins")
    await expect(shell).toBeVisible({ timeout: 15_000 })
    await expect(shell.locator('[data-slot="feature-page-header"]')).toHaveAttribute(
      "data-variant",
      "management"
    )

    // Nav sidebar, center pane, and library content all laid out.
    const nav = page.getByTestId("plugin-nav-library")
    const center = page.getByTestId("feature-shell-plugins-center")
    await expect(nav).toBeVisible()
    await expect(center).toBeVisible()
    await expect(page.getByTestId("plugin-library-pane")).toBeVisible()

    // Geometry, not class names: the nav rail sits left of the center pane
    // and the center gets the majority of the width.
    const navBox = await nav.boundingBox()
    const centerBox = await center.boundingBox()
    expect(navBox).not.toBeNull()
    expect(centerBox).not.toBeNull()
    expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(centerBox!.x + 1)
    expect(centerBox!.width).toBeGreaterThan(navBox!.width)

    // The capability rail is container-query gated at @xl (576px of the
    // CENTER PANE, not the viewport). With the current split
    // (nav 14% / center 52% / detail 34%) the center is ~750px at 1440, so
    // the rail takes layout space here. It used to be gated at @3xl (768px)
    // against a 39% center pane, which never opened on an ordinary desktop.
    const rail = page.getByTestId("plugin-library-capability-rail")
    await expect(rail).toBeVisible()
    const railBox = await rail.boundingBox()
    expect(railBox).not.toBeNull()
    expect(railBox!.width).toBeGreaterThanOrEqual(150)
    // The rail and its Sheet fallback are mutually exclusive by construction.
    await expect(page.getByTestId("plugin-category-sheet-trigger")).not.toBeVisible()
  })

  // The capability axis had NO reachable entry point between a >=1024px
  // viewport and a <768px center pane: the rail was container-gated while its
  // Sheet fallback was gated `lg:hidden` on the VIEWPORT, so both hid at once.
  // Both now key off the same container query, so exactly one is present at
  // every width. These are the widths that used to fall in the hole.
  for (const width of [1000, 1024, 1280, 1440]) {
    test(`capability filtering is reachable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto("/plugins?section=library", { waitUntil: "domcontentloaded" })
      await expect(page.getByTestId("plugin-library-pane")).toBeVisible({ timeout: 15_000 })

      const railVisible = await page.getByTestId("plugin-library-capability-rail").isVisible()
      const sheetVisible = await page.getByTestId("plugin-category-sheet-trigger").isVisible()
      expect(railVisible || sheetVisible).toBe(true)
      expect(railVisible && sheetVisible).toBe(false)
    })
  }

  test("dragging the center pane narrow swaps the rail for the Sheet trigger", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/plugins?section=library", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("plugin-library-capability-rail")).toBeVisible({
      timeout: 15_000,
    })

    // Drag the detail-pane handle left until the center falls under @xl.
    const handles = page.locator('[role="separator"]')
    const detailHandle = handles.last()
    const box = await detailHandle.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x - 420, box!.y + box!.height / 2, { steps: 12 })
    await page.mouse.up()

    await expect(page.getByTestId("plugin-library-capability-rail")).not.toBeVisible()
    await expect(page.getByTestId("plugin-category-sheet-trigger")).toBeVisible()
  })

  test("?section=governance&gov=permissions renders the governance pane", async ({ page }) => {
    await page.goto("/plugins?section=governance&gov=permissions", {
      waitUntil: "domcontentloaded",
    })
    await expect(page.getByTestId("plugin-governance-pane")).toBeVisible({ timeout: 15_000 })
    // The library pane must NOT be mounted — the section switch is real.
    await expect(page.getByTestId("plugin-library-pane")).toHaveCount(0)
  })

  test("legacy ?tab= deep links rewrite to the canonical section vocabulary", async ({ page }) => {
    await page.goto("/plugins?tab=permissions", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("plugin-governance-pane")).toBeVisible({ timeout: 15_000 })
    await expect(page).toHaveURL(/section=governance/)
    await expect(page).toHaveURL(/gov=permissions/)

    await page.goto("/plugins?tab=browse", { waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/section=discover/, { timeout: 15_000 })
  })

  test("discover section mounts the marketplace scroller", async ({ page }) => {
    await page.goto("/plugins?section=discover", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("plugin-marketplace-sections-scroller")).toBeVisible({
      timeout: 15_000,
    })
  })
})

test.describe("plugin workspace — mobile (375)", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page, MOBILE)
  })

  test("side panes collapse into Sheet triggers; no horizontal overflow", async ({ page }) => {
    await page.goto("/plugins?section=library", { waitUntil: "domcontentloaded" })
    const shell = page.getByTestId("feature-shell-plugins")
    await expect(shell).toBeVisible({ timeout: 15_000 })

    // The desktop nav rail is not laid out; its content lives behind the
    // left Sheet trigger.
    await expect(page.getByTestId("plugin-nav-library")).toHaveCount(0)
    const openNav = page.getByRole("button", { name: /open library/i })
    await expect(openNav).toBeVisible()

    // Real responsive regression check: the page must not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(0)

    // Opening the sheet exposes the nav; picking Governance switches the
    // center pane for real.
    await openNav.click()
    const navItem = page.getByTestId("plugin-nav-governance")
    await expect(navItem).toBeVisible()
    await navItem.click()
    await expect(page.getByTestId("plugin-governance-pane")).toBeVisible({ timeout: 15_000 })
  })

  test("the capability rail collapses into its Sheet trigger", async ({ page }) => {
    await page.goto("/plugins?section=library", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("plugin-library-pane")).toBeVisible({ timeout: 15_000 })
    // Container-query gated (@xl): on a phone the rail must not take layout
    // space, and the Sheet trigger must stand in for it.
    await expect(page.getByTestId("plugin-library-capability-rail")).not.toBeVisible()
    await expect(page.getByTestId("plugin-category-sheet-trigger")).toBeVisible()
  })
})

test.describe("settings → plugins launcher", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page, DESKTOP)
  })

  test("renders live status badges and canonical workspace links", async ({ page }) => {
    // The old spec swept 4 governance sub-tabs (?pluginsTab=…) that no
    // longer exist — Settings → Plugins is now a compact launcher into the
    // /plugins workspace.
    await page.goto("/settings?section=plugins", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("plugins-section-badges")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("link", { name: /open.*workspace/i })).toHaveAttribute(
      "href",
      "/plugins?section=library"
    )
    await expect(page.getByRole("link", { name: /governance/i })).toHaveAttribute(
      "href",
      "/plugins?section=governance&gov=permissions"
    )
  })
})
