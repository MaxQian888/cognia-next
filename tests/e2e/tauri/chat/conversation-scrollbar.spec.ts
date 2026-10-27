/**
 * Windows WebView2 regression for transcript scrollbar ownership. Browser
 * projects do not render the desktop chat. jsdom cannot observe native chrome,
 * pane container queries, or the interaction between their actual geometry.
 * Seed local text only; no model or external IM request is needed.
 */
import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

test.describe("tauri: one conversation scroll navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 })
    await page.emulateMedia({ forcedColors: "none" })
    await page.goto("/")
    await resetCogniaDb(page)
    await page.waitForFunction(
      () =>
        typeof window.__cogniaSeedConversation === "function" &&
        typeof window.__cogniaSetSettings === "function"
    )
    const sessionId = await page.evaluate(async () => {
      await window.__cogniaSetSettings!({
        conversationTimeline: { enabled: true, expanded: false },
      })
      return (await window.__cogniaSeedConversation!({ turns: 30 })).sessionId
    })
    await page.goto(`/?session=${sessionId}&message=seed-u-0`)
    await expect(page.getByRole("log")).toBeVisible()
    await expect(page.getByRole("scrollbar")).toBeVisible()
  })

  test("one rail owns scrolling and the thumb stays reachable below the expand button", async ({
    page,
  }) => {
    const log = page.getByRole("log")
    const rail = page.getByRole("scrollbar")
    await expect(rail).toHaveCount(1)
    await expect(rail).toHaveAttribute("aria-controls", (await log.getAttribute("id"))!)
    await expect(log).toHaveCSS("scrollbar-width", "none")
    expect(
      await log.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)
    ).toBeLessThanOrEqual(1)

    const expand = page.getByRole("button", {
      name: /expand conversation timeline|展开对话时间线/i,
    })
    const expandBox = (await expand.boundingBox())!
    const railBox = (await rail.boundingBox())!
    expect(railBox.y).toBeGreaterThanOrEqual(expandBox.y + expandBox.height)

    await rail.focus()
    await rail.press("Home")
    await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(0)
    await rail.press("PageDown")
    await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await rail.press("End")
    await expect
      .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThanOrEqual(1)

    await rail.hover()
    await page.mouse.wheel(0, -240)
    await expect
      .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeGreaterThan(100)

    await rail.press("Home")
    await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(0)
    const thumb = page.getByTestId("timeline-viewport-thumb")
    const thumbBox = (await thumb.boundingBox())!
    await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumbBox.x + thumbBox.width / 2, railBox.y + railBox.height + 20, {
      steps: 8,
    })
    await page.mouse.up()
    await expect
      .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThanOrEqual(1)
  })

  test("expanded, disabled and narrow states restore a thin native scrollbar", async ({ page }) => {
    const log = page.getByRole("log")
    await page.getByRole("button", { name: /expand conversation timeline|展开对话时间线/i }).click()
    await expect(page.getByRole("scrollbar")).toHaveCount(0)
    await expect(log).not.toHaveCSS("scrollbar-width", "none")
    await expect
      .poll(() => log.evaluate((el) => getComputedStyle(el, "::-webkit-scrollbar").width))
      .toBe("8px")

    await page.getByRole("button", { name: /collapse timeline|收起时间线/i }).click()
    await expect(log).toHaveCSS("scrollbar-width", "none")
    await page.setViewportSize({ width: 850, height: 1000 })
    await expect(page.getByRole("scrollbar")).toBeHidden()
    await expect(log).not.toHaveCSS("scrollbar-width", "none")
    await expect
      .poll(() => log.evaluate((el) => getComputedStyle(el, "::-webkit-scrollbar").width))
      .toBe("8px")

    await page.setViewportSize({ width: 1800, height: 1000 })
    await expect(page.getByRole("scrollbar")).toBeVisible()
    await page.evaluate(() =>
      window.__cogniaSetSettings!({
        conversationTimeline: { enabled: false, expanded: false },
      })
    )
    await expect(page.getByRole("scrollbar")).toHaveCount(0)
    await expect(log).not.toHaveCSS("scrollbar-width", "none")
  })

  test("forced colors restore platform navigation and hide the replacement rail", async ({
    page,
  }) => {
    const log = page.getByRole("log")
    await page.emulateMedia({ forcedColors: "active" })
    await expect(page.getByRole("scrollbar")).toBeHidden()
    await expect(
      page.getByRole("button", { name: /expand conversation timeline|展开对话时间线/i })
    ).toBeVisible()
    await expect(log).toHaveCSS("scrollbar-width", "auto")
    await log.focus()
    await log.press("Home")
    await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(0)
    await log.press("End")
    await expect
      .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThanOrEqual(1)
    await page.emulateMedia({ forcedColors: "none" })
    await expect(page.getByRole("scrollbar")).toBeVisible()
    await expect(log).toHaveCSS("scrollbar-width", "none")
  })
})
