/**
 * E2E: a plugin's `manifest.styles` sheet is bound to its own subtree.
 *
 * This is the half the unit tests cannot reach. `scopePluginCss` is pure and
 * covered in Jest, but jsdom does not implement `@scope` at all — those tests
 * assert the CSS *text* we generate, never that a browser honours the bound.
 * If `@scope` were unsupported or we emitted it slightly wrong, every unit test
 * would stay green while plugin CSS leaked across the whole app.
 *
 * So: generate the real CSS with the real function, hand it to a real browser,
 * and measure what actually gets painted.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { scopePluginCss } from "../../../lib/plugin/styles/plugin-stylesheet"

const PLUGIN_CSS = `
.leak-probe { color: rgb(255, 0, 0); }
@keyframes plugin-spin { from { opacity: 0 } to { opacity: 1 } }
.animated { animation: plugin-spin 1s linear infinite; }
`

test.describe("plugin stylesheet containment", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" })
  })

  test("applies inside the plugin's root and nowhere else", async ({ page }) => {
    const scoped = scopePluginCss(PLUGIN_CSS, "demo-plugin")

    const result = await page.evaluate((css) => {
      const style = document.createElement("style")
      style.textContent = css
      document.head.appendChild(style)

      const host = document.createElement("div")
      host.innerHTML = `
        <div data-plugin-root="demo-plugin">
          <span id="inside" class="leak-probe">in</span>
        </div>
        <span id="outside" class="leak-probe">out</span>
      `
      document.body.appendChild(host)

      const read = (id: string) => getComputedStyle(document.getElementById(id) as Element).color

      return { inside: read("inside"), outside: read("outside") }
    }, scoped)

    // The plugin styled its own element...
    expect(result.inside).toBe("rgb(255, 0, 0)")
    // ...and did not touch the identically-classed element outside its root.
    expect(result.outside).not.toBe("rgb(255, 0, 0)")
  })

  test("does not restyle a host element that shares a class name", async ({ page }) => {
    // The realistic accident: a plugin writes `.badge {}` and repaints the
    // app's own badges. `@scope` is what stops it.
    const scoped = scopePluginCss(".badge { color: rgb(0, 255, 0); }", "demo-plugin")

    const outside = await page.evaluate((css) => {
      const style = document.createElement("style")
      style.textContent = css
      document.head.appendChild(style)

      const hostBadge = document.createElement("span")
      hostBadge.className = "badge"
      hostBadge.id = "host-badge"
      document.body.appendChild(hostBadge)

      return getComputedStyle(hostBadge).color
    }, scoped)

    expect(outside).not.toBe("rgb(0, 255, 0)")
  })

  test("keeps hoisted @keyframes usable, which @scope would otherwise drop", async ({ page }) => {
    // `@keyframes` is invalid inside an `@scope` block. If the hoisting in
    // `splitHoistedAtRules` regressed, the rule would be dropped and the
    // element would simply never animate — silently.
    const scoped = scopePluginCss(PLUGIN_CSS, "demo-plugin")

    const animationCount = await page.evaluate((css) => {
      const style = document.createElement("style")
      style.textContent = css
      document.head.appendChild(style)

      const wrapper = document.createElement("div")
      wrapper.setAttribute("data-plugin-root", "demo-plugin")
      wrapper.innerHTML = `<span id="anim" class="animated">a</span>`
      document.body.appendChild(wrapper)

      return document.getElementById("anim")!.getAnimations().length
    }, scoped)

    expect(animationCount).toBeGreaterThan(0)
  })

  test("two plugins' sheets cannot reach each other", async ({ page }) => {
    const alpha = scopePluginCss(".shared { color: rgb(255, 0, 0); }", "alpha")
    const beta = scopePluginCss(".shared { color: rgb(0, 0, 255); }", "beta")

    const result = await page.evaluate(
      ({ a, b }) => {
        for (const css of [a, b]) {
          const style = document.createElement("style")
          style.textContent = css
          document.head.appendChild(style)
        }
        const host = document.createElement("div")
        host.innerHTML = `
          <div data-plugin-root="alpha"><span id="a" class="shared">a</span></div>
          <div data-plugin-root="beta"><span id="b" class="shared">b</span></div>
        `
        document.body.appendChild(host)
        return {
          a: getComputedStyle(document.getElementById("a")!).color,
          b: getComputedStyle(document.getElementById("b")!).color,
        }
      },
      { a: alpha, b: beta }
    )

    expect(result.a).toBe("rgb(255, 0, 0)")
    expect(result.b).toBe("rgb(0, 0, 255)")
  })

  test("the browser actually supports @scope", async ({ page }) => {
    // Everything above is meaningless if the engine silently ignores the
    // at-rule, so assert support directly rather than inferring it.
    const supported = await page.evaluate(() => CSS.supports("at-rule", "@scope"))
    // Not all engines implement the `at-rule` probe; fall back to parsing.
    const parses = await page.evaluate(() => {
      const style = document.createElement("style")
      style.textContent = "@scope ([data-x]) { .y { color: red } }"
      document.head.appendChild(style)
      const ok = (style.sheet?.cssRules.length ?? 0) > 0
      style.remove()
      return ok
    })
    expect(supported || parses).toBe(true)
  })
})
