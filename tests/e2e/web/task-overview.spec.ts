import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureAppMounted, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

/** The summary button sits in the title bar's actions slot (ADR-0214). */
function summaryTrigger(page: Page) {
  return page.getByTestId("title-bar-outlet-actions").getByRole("button", { name: /^Task summary/ })
}

async function openOverview(page: Page) {
  const trigger = summaryTrigger(page)
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click()
  const card = page.getByTestId("session-summary-card")
  await card.getByRole("button", { name: "Summary card options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Open task overview", exact: true }).click()
  await expect(page.getByTestId("session-overview-panel")).toBeVisible()
}

async function prepareConversations(page: Page) {
  // This spec exercises the title bar itself — opt the web shell back into it
  // (`webTitleBarEnabled` is off by default). An init script runs before the
  // app's JS on every navigation, so the flag is in place before the ui-store
  // rehydrates; the guard keeps it a one-time seed so later reloads preserve
  // whatever else the test changed in the store.
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
  const sessions = await page.evaluate(async () => {
    const first = await window.__cogniaSeedConversation!({ turns: 1, title: "Overview first task" })
    const second = await window.__cogniaSeedConversation!({
      turns: 0,
      title: "Overview second task",
    })
    return { first, second }
  })
  await page.goto(`/?session=${sessions.first.sessionId}`)
  await waitForTestGlobals(page, 30_000)
  await expect(
    page
      .getByRole("complementary", { name: "Conversations" })
      .getByRole("button", { name: /^Overview first task/ })
  ).toBeVisible()
  await page
    .getByRole("complementary", { name: "Conversations" })
    .getByRole("button", { name: /^Overview first task/ })
    .click()
  await expect(
    page.getByRole("banner").getByText("Overview first task", { exact: true })
  ).toBeVisible()
  const disableHud = page.getByRole("button", { name: "Disable HUD", exact: true })
  if (await disableHud.isVisible()) await disableHud.click()
  return sessions
}

test("@smoke task summary opens from the title bar and hands off to the task overview", async ({
  page,
}) => {
  await prepareConversations(page)
  await expect(page.getByTestId("title-bar-search-pill")).toHaveAttribute("data-compact", "true")
  await expect(page.getByTestId("title-bar-title")).toHaveCount(0)
  const rightControls = page.getByTestId("title-bar-right-chrome")
  for (const control of [
    rightControls.getByRole("button", { name: "Split view", exact: true }),
    rightControls.getByTestId("title-bar-search-pill"),
    rightControls.getByTestId("title-bar-navigation-menu"),
  ]) {
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThan(page.viewportSize()!.width * 0.8)
  }
  await expect(page.getByTestId("title-bar-nav-arrows")).toHaveCount(0)
  await page.getByTestId("title-bar-navigation-menu").click()
  await expect(page.getByTestId("title-bar-nav-arrows")).toBeVisible()
  // The sidebar projects the workspace switcher into the bar's start zone;
  // opening compact navigation must not create a duplicate workspace chip.
  const workspace = page.getByRole("banner").getByRole("button", { name: /^Active workspace:/ })
  await expect(workspace).toHaveCount(1)
  await expect(workspace).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("title-bar-nav-arrows")).toHaveCount(0)
  const toggle = page.getByRole("button", { name: "Toggle Right Sidebar", exact: true })
  if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  const conversation = page.getByRole("log")
  await expect(conversation).toBeVisible()
  const bounds = await conversation.boundingBox()

  // At this width there is no room beside the chat column, so the card opens
  // as a popover under its title-bar button rather than floating.
  const trigger = summaryTrigger(page)
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  const triggerBounds = (await trigger.boundingBox())!
  expect(triggerBounds.x).toBeGreaterThan(page.viewportSize()!.width * 0.8)
  await trigger.click()
  const card = page.getByTestId("session-summary-card")
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute("data-mode", "popover")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  const cardBounds = (await card.boundingBox())!
  expect(cardBounds.y).toBeGreaterThanOrEqual(triggerBounds.y + triggerBounds.height)
  expect(cardBounds.x + cardBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  // The project, the standing rows, and no column reserved for the card.
  await expect(card.getByText("No workspace", { exact: true })).toBeVisible()
  await expect(card.getByTestId("summary-row-changes")).toBeVisible()
  await expect(card.getByTestId("summary-sources")).toContainText("No sources used yet")
  await expect(page.locator("#session-summary-dock")).toHaveCount(0)
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  expect((await conversation.boundingBox())!.width).toBe(bounds!.width)
  await page.screenshot({ path: test.info().outputPath("task-summary.png"), fullPage: true })
  await page.keyboard.press("Escape")
  await expect(card).toBeHidden()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")

  await page
    .getByRole("complementary", { name: "Conversations" })
    .getByRole("button", { name: /^Overview second task/ })
    .click()
  await expect(
    page.getByRole("banner").getByText("Overview second task", { exact: true })
  ).toBeVisible()
  await openOverview(page)
  await expect(card).toBeHidden()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(
    page
      .getByTestId("session-overview-panel")
      .getByRole("heading", { name: "Overview second task" })
  ).toBeVisible()
})

test("@smoke task summary floats beside a wide chat and stays out of the column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await prepareConversations(page)
  const toggle = page.getByRole("button", { name: "Toggle Right Sidebar", exact: true })
  if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click()
  const trigger = summaryTrigger(page)
  const card = page.getByTestId("session-summary-card")
  // Shown without being asked: there is room in the gutter.
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute("data-mode", "float")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  const stage = page.locator('[data-slot="chat-surface-stage"]').first()
  await expect
    .poll(async () => {
      const box = await card.boundingBox()
      const area = await stage.boundingBox()
      if (!box || !area) return false
      // The chat column is centred on the stage and capped at 52rem (832px).
      const columnRight = area.x + (area.width + Math.min(area.width, 832)) / 2
      return (
        box.x + box.width <= area.x + area.width &&
        box.y >= area.y &&
        box.y + box.height <= area.y + area.height &&
        // Beside the centred column, never over it.
        box.x >= columnRight
      )
    })
    .toBe(true)
  await page.screenshot({ path: test.info().outputPath("task-summary-float.png"), fullPage: true })

  await trigger.click()
  await expect(card).toBeHidden()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await trigger.click()
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Summary card options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Hide card", exact: true }).click()
  await expect(card).toBeHidden()

  // Narrowing the window turns the floating card back into the popover.
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(card).toBeHidden()
  await trigger.click()
  await expect(card).toHaveAttribute("data-mode", "popover")

  // A row hidden from the card's menu stays hidden after a reload.
  await expect(card.getByTestId("summary-row-changes")).toBeVisible()
  await card.getByRole("button", { name: "Summary card options", exact: true }).click()
  await page.getByRole("menuitem", { name: /^Changes/ }).hover()
  await page.getByRole("menuitemradio", { name: "Hidden", exact: true }).click()
  await expect(card.getByTestId("summary-row-changes")).toHaveCount(0)
  await page.reload()
  await waitForTestGlobals(page, 30_000)
  await summaryTrigger(page).click()
  await expect(card).toBeVisible()
  await expect(card.getByTestId("summary-sources")).toBeVisible()
  await expect(card.getByTestId("summary-row-changes")).toHaveCount(0)
})

test("@smoke the dock's one tab strip switches, closes and remembers its tabs", async ({
  page,
}) => {
  await prepareConversations(page)
  await openOverview(page)
  const strip = page.getByRole("tablist", { name: "Open in this task", exact: true })
  await expect(strip.getByRole("tab", { name: "Task overview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  // No second navigation beside it: no workbench tabs, no activity rail.
  await expect(page.getByTestId("context-workbench-panel-tabs")).toHaveCount(0)
  await expect(page.getByTestId("context-workbench-activity-rail")).toHaveCount(0)

  await page
    .getByTestId("session-overview-panel")
    .getByRole("button", { name: "Open run context" })
    .click()
  await expect(strip.getByRole("tab", { name: "Run Context", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await strip.getByRole("tab", { name: "Task overview", exact: true }).click()
  await expect(page.getByTestId("session-overview-panel")).toBeVisible()
  await page.getByRole("button", { name: "Close Task overview", exact: true }).click()
  await expect(strip.getByRole("tab", { name: "Task overview", exact: true })).toHaveCount(0)
  await expect(strip.getByRole("tab", { name: "Run Context", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await page.screenshot({ path: test.info().outputPath("dock-tab-strip.png"), fullPage: true })

  // The tabs are this conversation's: a reload brings them back.
  await page.reload()
  await waitForTestGlobals(page, 30_000)
  await openOverview(page)
  await expect(strip.getByRole("tab", { name: "Run Context", exact: true })).toBeVisible()
  await expect(strip.getByRole("tab", { name: "Task overview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
})

// Exercise the registered overview and its existing run-context destination.
test("@smoke task overview follows the selected conversation and opens run context", async ({
  page,
}) => {
  const sessions = await prepareConversations(page)
  await openOverview(page)
  const overview = page.getByTestId("session-overview-panel")
  await expect(overview.getByRole("heading", { name: "Overview first task" })).toBeVisible()
  await expect(
    overview.getByRole("region", { name: "Current task", exact: true }).getByRole("status")
  ).toContainText("Idle")
  await expect(overview.getByRole("region", { name: "Capabilities", exact: true })).toBeVisible()
  await expect(overview.getByRole("region", { name: "Key results", exact: true })).toBeVisible()
  await expect(
    overview.getByText("File tracking is not available for this session yet.")
  ).toBeVisible()
  await overview.locator("summary", { hasText: "Technical details" }).click()
  await expect(overview.getByText(sessions.first.sessionId, { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("task-overview.png"), fullPage: true })
  await overview.getByRole("heading", { name: "Overview first task" }).scrollIntoViewIfNeeded()
  await page.screenshot({
    path: test.info().outputPath("task-overview-current.png"),
    fullPage: true,
  })
  await overview.getByRole("button", { name: "Open run context" }).click()
  await expect(page.getByRole("tab", { name: "Working Set", exact: true })).toBeVisible()
  await expect(overview).toBeHidden()

  await page
    .getByRole("complementary", { name: "Conversations" })
    .getByRole("button", { name: /^Overview second task/ })
    .click()
  await expect(
    page.getByRole("banner").getByText("Overview second task", { exact: true })
  ).toBeVisible()
  await openOverview(page)
  await expect(overview.getByRole("heading", { name: "Overview second task" })).toBeVisible()
  await expect(overview.getByRole("heading", { name: "Overview first task" })).toHaveCount(0)
  await overview.locator("summary", { hasText: "Technical details" }).click()
  await expect(overview.getByText(sessions.second.sessionId, { exact: true })).toBeVisible()
  await expect(overview.getByText(sessions.first.sessionId, { exact: true })).toHaveCount(0)
})
