import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

async function openOverview(page: Page) {
  await page.getByRole("button", { name: "Task summary", exact: true }).click()
  await page
    .getByTestId("session-summary")
    .getByRole("button", { name: "View details", exact: true })
    .click()
  await expect(page.getByTestId("session-overview-panel")).toBeVisible()
}

async function prepareConversations(page: Page) {
  await page.goto("/")
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/")
  await waitForTestGlobals(page, 30_000)
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

test("@smoke task summary reserves narrow space and opens the selected task details", async ({
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
  await expect(page.getByTestId("title-bar-workspace")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("title-bar-nav-arrows")).toHaveCount(0)
  const toggle = page.getByRole("button", { name: "Toggle Right Sidebar", exact: true })
  if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  const conversation = page.getByRole("log")
  await expect(conversation).toBeVisible()
  const bounds = await conversation.boundingBox()
  const trigger = page
    .getByTestId("title-bar-outlet-actions")
    .getByRole("button", { name: "Task summary", exact: true })
  await expect(trigger).toBeVisible()
  const triggerBounds = await trigger.boundingBox()
  expect(triggerBounds).not.toBeNull()
  expect(triggerBounds!.x).toBeGreaterThan(page.viewportSize()!.width * 0.8)
  await trigger.click()
  const summary = page.getByTestId("session-summary")
  await expect(summary).toBeVisible()
  const reserved = page.locator("#session-summary-dock")
  await expect(reserved).toBeVisible()
  await expect
    .poll(async () => {
      const region = await reserved.boundingBox()
      const chat = await conversation.boundingBox()
      if (!region || !chat || !bounds) return false
      return (
        region.width >= 250 &&
        region.width <= 290 &&
        region.y >= triggerBounds!.y + triggerBounds!.height &&
        chat.x + chat.width <= region.x + 1 &&
        Math.abs(bounds.width - chat.width - region.width) <= 2 &&
        region.x + region.width <= page.viewportSize()!.width
      )
    })
    .toBe(true)
  await expect(summary.getByRole("status")).toContainText("Idle")
  await expect(summary.getByText("Open questions and subtasks", { exact: true })).toBeVisible()
  const card = page.getByTestId("session-summary-card")
  await expect(card).toBeVisible()
  // The card grew a title row, a status rail and an open-items block; it still
  // has to stay well short of the column so the reserved region reads as a card
  // rather than a second panel.
  expect((await card.boundingBox())!.height).toBeLessThanOrEqual(440)
  // Closing is the toolbar trigger's job — there is deliberately no close
  // control inside the card.
  await expect(card.getByRole("button", { name: /close/i })).toHaveCount(0)
  await expect(card.getByRole("heading", { name: "Overview first task" })).toBeVisible()
  // Status moved out of the definition list and into the rail.
  await expect(summary.locator("dt")).toHaveText(["Mode", "Agent", "Environment", "Sharing"])
  expect(
    await summary.locator("dl").evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true)
  await expect
    .poll(async () => {
      const outer = await reserved.boundingBox()
      const inner = await card.boundingBox()
      if (!outer || !inner) return false
      return (
        Math.abs(inner.x - outer.x - 12) <= 2 &&
        Math.abs(inner.y - outer.y - 12) <= 2 &&
        Math.abs(outer.x + outer.width - inner.x - inner.width - 12) <= 2 &&
        inner.height < outer.height - 24
      )
    })
    .toBe(true)
  expect(
    await card.evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius))
  ).toBeGreaterThanOrEqual(8)
  await expect(summary.getByText("Technical details", { exact: true })).toHaveCount(0)
  await expect(summary.getByText("No artifacts yet", { exact: true })).toHaveCount(0)
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  expect((await conversation.boundingBox())!.width).toBeLessThan(bounds!.width)
  await page.screenshot({ path: test.info().outputPath("task-summary.png"), fullPage: true })
  await page.keyboard.press("Escape")
  await expect(summary).toBeHidden()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect.poll(async () => (await conversation.boundingBox())?.width).toBe(bounds?.width)

  await page
    .getByRole("complementary", { name: "Conversations" })
    .getByRole("button", { name: /^Overview second task/ })
    .click()
  await expect(
    page.getByRole("banner").getByText("Overview second task", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Task summary", exact: true }).click()
  await expect(summary).toBeVisible()
  await summary.getByRole("button", { name: "View details", exact: true }).click()
  await expect(summary).toBeHidden()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(
    page
      .getByTestId("session-overview-panel")
      .getByRole("heading", { name: "Overview second task" })
  ).toBeVisible()
})

test("@smoke workbench tabs switch close reopen and preserve navigation preference", async ({
  page,
}) => {
  await prepareConversations(page)
  await openOverview(page)
  const tabs = page.getByRole("tablist", { name: "Labeled tabs", exact: true })
  await expect(tabs.getByRole("tab", { name: "Task overview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await page.getByRole("button", { name: "Open panel", exact: true }).click()
  await page.getByRole("menuitem", { name: "Run Context", exact: true }).click()
  await expect(tabs.getByRole("tab", { name: "Run Context", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByRole("tab", { name: "Working Set", exact: true })).toBeVisible()
  await tabs.getByRole("tab", { name: "Task overview", exact: true }).click()
  await expect(page.getByTestId("session-overview-panel")).toBeVisible()
  await tabs.getByRole("button", { name: "Close Task overview", exact: true }).click()
  await expect(tabs.getByRole("tab", { name: "Task overview", exact: true })).toHaveCount(0)
  await expect(tabs.getByRole("tab", { name: "Run Context", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await page.getByRole("button", { name: "Open panel", exact: true }).click()
  await page.getByRole("menuitem", { name: "Task overview", exact: true }).click()
  await expect(tabs.getByRole("tab", { name: "Task overview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(tabs.getByRole("tab", { name: "Run Context", exact: true })).toBeInViewport({
    ratio: 1,
  })
  await expect(tabs.getByRole("tab", { name: "Task overview", exact: true })).toBeInViewport({
    ratio: 1,
  })
  await page.screenshot({ path: test.info().outputPath("workbench-tabs.png"), fullPage: true })

  await page.getByRole("button", { name: "Compact icon rail", exact: true }).click()
  const rail = page.getByRole("navigation", { name: "Context Workbench activities" })
  await expect(rail).toBeVisible()
  await expect(tabs).toHaveCount(0)
  await page.reload()
  await waitForTestGlobals(page, 30_000)
  const toggle = page.getByRole("button", { name: "Toggle Right Sidebar", exact: true })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await expect(rail).toBeVisible()
  await page.getByRole("button", { name: "Labeled tabs", exact: true }).click()
  await expect(tabs).toBeVisible()
  await page.reload()
  await waitForTestGlobals(page, 30_000)
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await expect(tabs).toBeVisible()
  await expect(rail).toHaveCount(0)
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
