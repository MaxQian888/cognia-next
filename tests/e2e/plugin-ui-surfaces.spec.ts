import { expect, test, type Locator, type Page } from "@/tests/e2e/fixtures/test"

/**
 * The reference plugin's whole stylesheet is one rule: `.ref-badge { outline:
 * 2px solid rgb(239, 68, 68) }`. Every surface renders a `.ref-badge`, and the
 * host renders one of its own outside every plugin root — so a single computed
 * property answers both halves of the contract per surface: the plugin's sheet
 * reached its own content, and it reached nothing else.
 */
const PLUGIN_OUTLINE = "rgb(239, 68, 68)"

async function expectScoped(badge: Locator): Promise<void> {
  await expect(badge).toHaveCSS("outline-style", "solid")
  await expect(badge).toHaveCSS("outline-width", "2px")
  await expect(badge).toHaveCSS("outline-color", PLUGIN_OUTLINE)
}

async function expectNotScoped(badge: Locator): Promise<void> {
  await expect(badge).toHaveCSS("outline-style", "none")
}

/** Surfaces whose badge sits in the harness DOM, mounted without interaction. */
const INLINE_SURFACES = [
  "composer-action",
  "context-panel",
  "message-renderer",
  "tool-renderer",
  "config",
] as const

/**
 * Boot the harness page and wait for it to swap its loading state for the real
 * surfaces.
 *
 * Two things here are not incidental:
 *
 *  - **Do not seed an account.** The harness and its E2E plugin runtime mount
 *    above `AccountGate`. Keeping the gate closed prevents the normal app
 *    initializers from opening a second Dexie connection while the plugin
 *    manager applies its dynamic schema.
 *  - **Wait explicitly.** Enabling a plugin through the real manager takes far
 *    longer than Playwright's 5s assertion default (10–45s here), so an implicit
 *    wait makes the whole file look broken whenever the machine is busy.
 */
async function gotoHarness(page: Page, search = ""): Promise<Locator> {
  await page.goto(`/e2e/plugin-ui-surfaces${search}`, { waitUntil: "domcontentloaded" })
  const harness = page.getByTestId("plugin-surface-reference-harness")
  await expect(harness).toBeVisible({ timeout: 60_000 })
  return harness
}

/**
 * Surfaces that portal out of the harness subtree. They are located from the
 * page root, not from the harness, precisely because the portal escapes it —
 * which is also why their scoping is worth asserting separately: `@scope` is
 * bound to `[data-plugin-root]`, an attribute the surface carries with it into
 * the portal, not to the harness's position in the tree.
 */
async function openOverlaySurfaces(page: Page, harness: Locator): Promise<void> {
  await page.keyboard.press("Escape")
  await harness
    .locator('[data-reference-case="composer-menu"]')
    .getByRole("button", { name: "Composer menu" })
    .click()
}

test.describe("plugin UI surfaces", () => {
  test.describe.configure({ mode: "serial" })

  test("enables the reference plugin and mounts every production host", async ({ page }) => {
    const harness = await gotoHarness(page)

    const actionCase = harness.locator('[data-reference-case="composer-action"]')
    const actionSurface = actionCase.locator("[data-plugin-surface]")
    await expect(actionSurface).toHaveCSS("min-width", "min(32px, 100%)")
    await expect(actionSurface).toHaveCSS("max-width", "min(80px, 100%)")

    await expect(
      harness.locator('[data-reference-case="context-panel"] [data-plugin-surface]')
    ).toHaveCount(1)
    await expect(
      harness.locator('[data-reference-case="context-webview"] [data-plugin-surface]')
    ).toHaveAttribute("data-plugin-surface", /context-panel-webview:/)
    await expect(
      harness.locator('[data-reference-case="context-webview"] [data-plugin-root]')
    ).toHaveCount(0)
    const viewContainer = harness.locator('[data-reference-case="view-container"]')
    await expect(
      viewContainer.locator('[data-plugin-surface="view-container:reference"]')
    ).toHaveCount(1)
    await expect(viewContainer.locator('[data-plugin-surface="view:reference-tree"]')).toHaveCount(
      1
    )
    await expect(
      viewContainer.locator('[data-plugin-surface="view:reference-custom"]')
    ).toHaveCount(1)
    await expect(
      viewContainer.locator('[data-plugin-surface="view:reference-webview"]')
    ).toHaveCount(1)
    await expect(
      viewContainer.locator('[data-plugin-surface="view:reference-webview"] [data-plugin-root]')
    ).toHaveCount(0)
    await expect(
      harness.locator('[data-reference-case="message-renderer"] [data-plugin-surface]')
    ).toHaveCount(1)
    await expect(
      harness.locator('[data-reference-case="tool-renderer"] [data-plugin-surface]')
    ).toHaveCount(1)
    await expect(
      harness.locator('[data-reference-case="config"] [data-plugin-surface]')
    ).toHaveCount(1)
    await expect(page.locator('[data-plugin-surface^="modal:"]')).toHaveCount(1)

    await openOverlaySurfaces(page, harness)
    await expect(page.locator('[data-reference-surface="composer-menu"]')).toBeVisible()
    await page.keyboard.press("Escape")
    await harness
      .locator('[data-reference-case="quick-action"]')
      .getByRole("button", { name: /quick actions/i })
      .click()
    await expect(page.locator('[data-plugin-surface^="quick-action:"]')).toBeVisible()
  })

  test("scopes the plugin stylesheet to each surface and to no host DOM", async ({ page }) => {
    const harness = await gotoHarness(page)

    for (const id of INLINE_SURFACES) {
      await expectScoped(
        harness.locator(`[data-reference-case="${id}"] .ref-badge[data-reference-surface="${id}"]`)
      )
    }
    await expectScoped(
      harness.locator(
        '[data-reference-case="view-container"] [data-reference-surface="custom-view"]'
      )
    )
    await expectScoped(
      harness.locator('[data-reference-case="view-container"] [data-tree-node="reference-root"]')
    )

    // Portaled out of the harness; the surface carries `data-plugin-root` with
    // it, so the scope must still bind.
    await expectScoped(page.locator('[data-plugin-surface^="modal:"] .ref-badge'))

    await openOverlaySurfaces(page, harness)
    await expectScoped(page.locator('[data-reference-surface="composer-menu"]'))
    await page.keyboard.press("Escape")

    // The quick-action surface wraps a label this host renders from registry
    // data — the plugin contributes no component there, so there is no badge to
    // scope. Assert the surface is a plugin root all the same: that attribute is
    // what would bind the sheet the day a plugin does render into it.
    await harness
      .locator('[data-reference-case="quick-action"]')
      .getByRole("button", { name: /quick actions/i })
      .click()
    await expect(page.locator('[data-plugin-surface^="quick-action:"]')).toHaveAttribute(
      "data-plugin-root",
      "ui-surface-reference"
    )
    await page.keyboard.press("Escape")

    // The control: host DOM wearing the plugin's own class name, untouched.
    await expectNotScoped(page.getByTestId("host-ref-badge"))

    // …and nothing else in the host document either. `@scope` is the only thing
    // standing between a plugin's `.badge {}` and every badge in the app, so
    // assert the invariant over the whole document rather than one probe.
    const leaks = await page.evaluate(
      (outline) =>
        [...document.querySelectorAll(".ref-badge")]
          .filter((el) => getComputedStyle(el).outlineColor === outline)
          .filter((el) => !el.closest("[data-plugin-root]"))
          .map((el) => el.getAttribute("data-testid") ?? el.tagName),
      PLUGIN_OUTLINE
    )
    expect(leaks).toEqual([])
  })

  // Webview surfaces are the deliberate exception: an iframe has its own
  // document, so the host's `@scope`d sheet cannot reach it — which is why
  // `PluginSurface` gives them `variant="iframe"` and withholds
  // `data-plugin-root`. Assert the boundary holds rather than leaving the two
  // surfaces unchecked.
  test("leaves webview surfaces to their own document", async ({ page }) => {
    await gotoHarness(page)

    for (const [viewId, surfaceId] of [
      ["reference-webview", "webview"],
      ["context-webview", "context-webview"],
    ] as const) {
      const badge = page
        .frameLocator(`[data-plugin-webview="ui-surface-reference:${viewId}"]`)
        .locator(`[data-reference-surface="${surfaceId}"]`)
      await expect(badge).toBeVisible()
      await expectNotScoped(badge)
    }
  })

  test("silently removes a crashing compact surface without changing its width", async ({
    page,
  }) => {
    const harness = await gotoHarness(page, "?pluginSurfaceCrash=composer-action")

    const surface = harness.locator('[data-reference-case="composer-action"] [data-plugin-surface]')
    await expect(surface).toBeAttached()
    await expect(surface).toHaveCSS("min-width", "min(32px, 100%)")
    await expect(surface).toHaveCSS("max-width", "min(80px, 100%)")
    await expect(surface.locator('[data-reference-surface="composer-action"]')).toHaveCount(0)
    await expect(surface.getByRole("alert")).toHaveCount(0)
  })

  test("shows the real plugin name in a localized panel failure and retries", async ({ page }) => {
    const harness = await gotoHarness(page, "?pluginSurfaceCrash=context-panel")
    await page.keyboard.press("Escape")

    const surface = harness.locator('[data-reference-case="context-panel"] [data-plugin-surface]')
    await expect(surface.getByRole("alert")).toContainText("UI Surface Reference could not render")
    await page.evaluate(() => {
      window.history.replaceState({}, "", "/e2e/plugin-ui-surfaces")
    })
    await surface.getByRole("button", { name: "Retry" }).click()
    await expect(surface.locator('[data-reference-surface="context-panel"]')).toBeVisible()
  })

  for (const [surfaceId, selector] of [
    [
      "custom-view",
      '[data-reference-case="view-container"] [data-plugin-surface="view:reference-custom"]',
    ],
    ["config", '[data-reference-case="config"] [data-plugin-surface]'],
  ] as const) {
    test(`routes a crashing ${surfaceId} through the shared retryable boundary`, async ({
      page,
    }) => {
      const harness = await gotoHarness(page, `?pluginSurfaceCrash=${surfaceId}`)
      await page.keyboard.press("Escape")
      const surface = harness.locator(selector)

      await expect(surface.getByRole("alert")).toBeVisible()
      await expect(surface.getByRole("alert")).toContainText("UI Surface Reference")
    })
  }

  test("switches every reference label through LocaleGate and the plugin registry", async ({
    page,
  }) => {
    const harness = await gotoHarness(page, "?pluginSurfaceLocale=zh-CN")

    const labels = harness.locator("[data-reference-label]")
    await expect(labels).toHaveCount(10)
    await expect(harness.locator('[data-reference-label="composer-action"]')).toHaveText("输入操作")
    await expect(harness.locator('[data-reference-label="message-renderer"]')).toHaveText(
      "消息渲染器"
    )
    await expect(harness.locator('[data-reference-label="config"]')).toHaveText("配置")
  })
})
