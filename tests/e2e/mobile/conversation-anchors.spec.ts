/**
 * E2E: the conversation jump pill's position, and message permalinks.
 *
 * This exists because the defect it pins is invisible to every other layer of
 * the suite. The jump control used to be an `absolute bottom-4` child of the
 * scroll container itself, which makes it part of the scrollable content: it
 * was positioned against the *unscrolled* box and scrolled away with the
 * messages, so once you were more than about a viewport up — precisely when the
 * control exists at all — it was off-screen. jsdom has no layout engine, so no
 * unit test can tell a visible button from one parked 2000px above the viewport.
 *
 * Everything asserted here is therefore geometric. Behavioural questions (which
 * mode the pill offers, what a timeline row jumps to, how the landing mark
 * expires) belong to the co-located unit suites and are not repeated.
 *
 * Runs on the Capacitor shell, not the desktop browser build: the latter shows
 * a "run inside Tauri" banner instead of a chat pane, which is why the mobile
 * shell already owns the browser-project chat contract (see
 * `./standalone-chat.spec.ts`). The right-edge timeline minimap
 * is deliberately desktop-only (`shouldMountTimeline` bails on mobile), so its
 * geometry is not covered here — its behaviour is unit-tested, and its lane vs
 * the scrollbar needs a real desktop shell to observe.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

/** Past VIRTUALIZE_THRESHOLD (40 messages) and long enough to overflow. */
const TURNS = 30

declare global {
  interface Window {
    __cogniaSeedConversation?: (draft: {
      turns: number
      title?: string
    }) => Promise<{ sessionId: string; messageIds: string[] }>
  }
}

async function seedConversation(page: Page): Promise<string> {
  // The bridge mounts in an effect, so it is not on `window` the instant the
  // navigation settles.
  await page.waitForFunction(() => typeof window.__cogniaSeedConversation === "function", null, {
    timeout: 30_000,
  })
  const seeded = await page.evaluate(
    async (turns) => window.__cogniaSeedConversation!({ turns }),
    TURNS
  )
  return seeded.sessionId
}

/** The message list's scroll container. */
const LOG = '[role="log"]'

async function scrollLog(page: Page, top: number | "bottom") {
  await page.evaluate(
    ({ selector, target }) => {
      const el = document.querySelector(selector) as HTMLElement | null
      if (!el) return
      el.scrollTop = target === "bottom" ? el.scrollHeight : (target as number)
    },
    { selector: LOG, target: top }
  )
}

/**
 * Scroll to `top` until the pill settles on `mode`.
 *
 * Landing via a permalink is itself a jump, so it legitimately arms the
 * "return to where you were" offer — which outranks the other two and survives
 * being at the bottom. A manual scroll retires it, but only once the jump's own
 * settle window (PROGRAMMATIC_SCROLL_MS) has lapsed, since until then the list
 * cannot tell the user's scrolling from the jump's. Polling the scroll rather
 * than sleeping a fixed amount keeps that coupling out of the test.
 */
async function scrollUntilPillMode(page: Page, top: number | "bottom", mode: string | null) {
  await expect
    .poll(
      async () => {
        await scrollLog(page, top)
        const pill = page.getByTestId("conversation-jump-pill")
        return (await pill.count()) === 0 ? null : await pill.getAttribute("data-mode")
      },
      { timeout: 15_000 }
    )
    .toBe(mode)
}

/** Distance from the bottom of the scrollable range, in px. */
function distanceFromBottom(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return -1
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }, LOG)
}

test.describe("conversation anchors", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone")
  })

  test("@critical the jump pill stays inside the viewport when scrolled up", async ({ page }) => {
    const sessionId = await seedConversation(page)
    // A permalink is also the most direct way to open a seeded conversation.
    await page.goto(`/?session=${sessionId}&message=seed-u-0`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page.locator(LOG)).toBeVisible({ timeout: 30_000 })

    await scrollUntilPillMode(page, 0, "toBottom")
    const pill = page.getByTestId("conversation-jump-pill")
    await expect(pill).toBeVisible()

    // The real assertion. `toBeVisible` only proves the node is rendered and
    // not display:none — being INSIDE the viewport is what regressed, and what
    // no jsdom test can observe.
    const box = await pill.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)

    // And it does what it offers.
    await pill.click()
    await expect.poll(() => distanceFromBottom(page), { timeout: 10_000 }).toBeLessThan(40)
  })

  test("the pill stays out of the way once the newest message is on screen", async ({ page }) => {
    // It floats over the message list, so an always-on pill would cover the
    // tail of the conversation being read.
    const sessionId = await seedConversation(page)
    await page.goto(`/?session=${sessionId}&message=seed-u-0`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page.locator(LOG)).toBeVisible({ timeout: 30_000 })

    // Retire the permalink's own return offer first — it deliberately outranks
    // everything else, including being at the bottom.
    await scrollUntilPillMode(page, 0, "toBottom")
    await scrollUntilPillMode(page, "bottom", null)
  })

  test("a permalink lands on the linked message and clears itself from the URL", async ({
    page,
  }) => {
    const sessionId = await seedConversation(page)
    const target = "seed-u-3"
    await page.goto(`/?session=${sessionId}&message=${target}`, {
      waitUntil: "domcontentloaded",
    })

    const row = page.locator(`[data-msg-id="${target}"]`)
    await expect(row).toBeVisible({ timeout: 30_000 })

    const box = await row.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(box!.y).toBeLessThan(viewport!.height)
    expect(box!.y + box!.height).toBeGreaterThan(0)

    // Consumed exactly once: a query left in place re-fires the jump on every
    // later render and pins the view to the linked message.
    await expect.poll(() => new URL(page.url()).search, { timeout: 10_000 }).toBe("")
  })
})
