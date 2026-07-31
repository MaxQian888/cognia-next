/**
 * E2E: pull-to-refresh primitive — tugging the list past the trigger point
 * arms the refresh spinner.
 *
 * Binds to the real wrapper (data-testid="pull-to-refresh") on the mobile
 * discover surface — the one mobile body that actually mounts
 * <PullToRefresh /> (components/mobile/discover/discover-mobile-body.tsx).
 * An earlier version targeted /inbox (which never mounts the primitive),
 * fell back to `.or(inbox-sidebar)`, and ended without a single outcome
 * assertion — the drag could be completely dead and the test stayed green.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile interactions — pull-to-refresh", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    await setCogniaSettings(page, { mobileRuntimeMode: "standalone" })
  })

  test("pulling down past the threshold arms the refresh spinner", async ({ page }) => {
    await page.goto("/discover")
    const wrapper = page.getByTestId("pull-to-refresh").first()
    await expect(wrapper).toBeVisible({ timeout: 15_000 })

    // Input channel: synthetic pointer events dispatched on the wrapper.
    // Both real channels are hijacked by browser-native behaviors before
    // the component sees a vertical drag — a MOUSE drag across the list's
    // links starts an HTML5 drag (pointer stream cancelled), and a TOUCH
    // drag on scrollable content becomes a native scroll gesture
    // (pointercancel after slop) because PullToRefresh sets no touch-action.
    // The latter is a product-bug candidate recorded in the e2e-suite
    // revival plan §7 — on real phones the pull likely dies the same way.
    // Until that's resolved, this spec pins the component contract:
    // pointerdown → move past triggerPx must translate the content and,
    // on release, run the full commit → refresh → reset lifecycle.
    const result = await wrapper.evaluate(async (el) => {
      const refreshLifecycle = new Promise<boolean>((resolve) => {
        let sawRefreshing = el.getAttribute("data-refreshing") === "true"
        const observer = new MutationObserver(() => {
          if (el.getAttribute("data-refreshing") === "true") {
            sawRefreshing = true
          } else if (sawRefreshing) {
            observer.disconnect()
            resolve(true)
          }
        })
        observer.observe(el, { attributes: true, attributeFilter: ["data-refreshing"] })
      })
      const box = el.getBoundingClientRect()
      const x = box.x + box.width / 2
      const startY = box.y + box.height * 0.4
      const fire = (type: string, y: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "touch",
            clientX: x,
            clientY: y,
          })
        )
      fire("pointerdown", startY)
      for (let i = 1; i <= 12; i++) {
        fire("pointermove", startY + (230 * i) / 12)
        await new Promise((r) => setTimeout(r, 16))
      }
      const content = el.children[1] as HTMLElement | undefined
      const t = content?.style.transform ?? ""
      const m = /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(t)
      const translatedNow = m ? Number(m[1]) : 0
      fire("pointerup", startY + 230)
      return { translated: translatedNow, completed: await refreshLifecycle }
    })
    expect(result.translated).toBeGreaterThanOrEqual(64)

    // Mutation observation proves the transient true state was rendered before
    // the wrapper settled, avoiding a vacuous final-state-only assertion.
    expect(result.completed).toBe(true)
    await expect(wrapper).toHaveAttribute("data-refreshing", "false")
  })
})
