import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureAppMounted, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

/**
 * The chat row's width budget (ADR-0214, D5): whatever the window, the open
 * dock never squeezes the conversation under `CHAT_MIN_PX`, and the summary
 * card stays on screen. The fold and overlay steps need a dock floor the web
 * shell's compact dock never reaches at desktop widths (the workspace profile
 * is a desktop-host surface), so they are pinned by the unit tests beside
 * `lib/shell/chat-row-budget.ts` and `artifact-workspace-dock.tsx`; this spec
 * pins the geometry a browser can see.
 */

const CHAT_MIN_PX = 420

async function openConversation(page: Page) {
  // The summary button projects into the title bar, which the web shell only
  // mounts when asked (`webTitleBarEnabled`, default off).
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("cognia-ui")
    const persisted = raw
      ? (JSON.parse(raw) as { state?: Record<string, unknown>; version?: number })
      : { state: {}, version: 3 }
    if (persisted.state?.webTitleBarEnabled === true) return
    persisted.state = { ...persisted.state, webTitleBarEnabled: true }
    window.localStorage.setItem("cognia-ui", JSON.stringify(persisted))
  })
  await page.goto("/")
  await ensureAppMounted(page)
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-12T00:00:00.000Z" },
  })
  const session = await page.evaluate(() =>
    window.__cogniaSeedConversation!({ turns: 2, title: "Narrow window task" })
  )
  await page.goto(`/?session=${session.sessionId}`)
  await waitForTestGlobals(page, 30_000)
  const disableHud = page.getByRole("button", { name: "Disable HUD", exact: true })
  if (await disableHud.isVisible()) await disableHud.click()
}

function stage(page: Page) {
  return page.locator('[data-slot="chat-surface-stage"]').first()
}

test("@smoke the open dock keeps the chat readable from 1600px down to a tablet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openConversation(page)
  const toggle = page.getByRole("button", { name: "Toggle Right Sidebar", exact: true })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")

  for (const width of [1600, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    // Docked beside the chat, not floated: the compact dock always fits here.
    await expect(page.getByTestId("artifact-workspace-dock")).not.toHaveAttribute(
      "data-dock-overlay",
      /.*/
    )
    await expect
      .poll(async () => (await page.getByTestId("artifact-dock-wrapper").boundingBox())?.width)
      .toBeGreaterThan(0)
    await expect
      .poll(async () => (await stage(page).boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(CHAT_MIN_PX)
    await page.screenshot({ path: test.info().outputPath(`dock-${width}.png`) })
  }

  // Below the desktop breakpoint the dock becomes the Sheet and the chat takes
  // the whole row.
  for (const width of [960, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByTestId("artifact-workspace-dock-mobile")).toBeVisible()
    await expect
      .poll(async () => (await stage(page).boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(CHAT_MIN_PX)
  }
})

test("@smoke the summary card stays on screen, and inside the stage when it floats", async ({
  page,
}) => {
  for (const width of [1600, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    if (width === 1600) await openConversation(page)
    const trigger = page
      .getByTestId("title-bar-outlet-actions")
      .getByRole("button", { name: /^Task summary/ })
    const card = page.getByTestId("session-summary-card")
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click()
    await expect(card).toBeVisible()
    const box = (await card.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y + box.height).toBeLessThanOrEqual(900)
    if ((await card.getAttribute("data-mode")) === "float") {
      const area = (await stage(page).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(area.x)
      expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width)
      expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height)
    } else {
      await page.keyboard.press("Escape")
      await expect(card).toBeHidden()
    }
  }
})
