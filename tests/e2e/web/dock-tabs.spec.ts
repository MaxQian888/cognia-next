import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureAppMounted, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

/**
 * The chat dock's one tab strip and per-task memory (ADR-0214, D6 / D7 / D9):
 * the New Tab page, a tool opening in its place, drag reordering, the last tab
 * closing the dock, and each conversation getting its own tabs and open state
 * back on the way in.
 */

async function prepareConversations(page: Page) {
  // The dock toggle lives in the title bar, which the web shell mounts only
  // when asked (`webTitleBarEnabled`, default off).
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
    const first = await window.__cogniaSeedConversation!({ turns: 1, title: "Tabs first task" })
    const second = await window.__cogniaSeedConversation!({ turns: 1, title: "Tabs second task" })
    return { first, second }
  })
  await page.goto(`/?session=${sessions.first.sessionId}`)
  await waitForTestGlobals(page, 30_000)
  const disableHud = page.getByRole("button", { name: "Disable HUD", exact: true })
  if (await disableHud.isVisible()) await disableHud.click()
  return sessions
}

function dockToggle(page: Page) {
  return page.getByRole("button", { name: "Toggle Right Sidebar", exact: true })
}

function strip(page: Page) {
  return page.getByRole("tablist", { name: "Open in this task", exact: true })
}

async function openConversation(page: Page, title: string) {
  await page
    .getByRole("complementary", { name: "Conversations" })
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .click()
  await expect(page.getByRole("banner").getByText(title, { exact: true })).toBeVisible()
}

async function openDock(page: Page) {
  const toggle = dockToggle(page)
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
}

test("@smoke an empty dock opens on the New Tab page, and a tool opens in its place", async ({
  page,
}) => {
  await prepareConversations(page)
  await openConversation(page, "Tabs first task")
  await openDock(page)

  await expect(strip(page).getByRole("tab", { name: "New tab", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByTestId("dock-new-tab-page")).toBeVisible()
  await expect(page.getByTestId("context-workbench-activity-rail")).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("dock-new-tab.png"), fullPage: true })

  await page.getByTestId("dock-new-tab-tool-metadata").click()
  await expect(
    strip(page).getByRole("tab", { name: "Task overview", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  await expect(strip(page).getByRole("tab", { name: "New tab", exact: true })).toHaveCount(0)
  await expect(page.getByTestId("session-overview-panel")).toBeVisible()
})

test("@smoke tabs reorder by drag, and closing the last one closes the dock", async ({ page }) => {
  await prepareConversations(page)
  await openConversation(page, "Tabs first task")
  await openDock(page)

  await page.getByTestId("dock-new-tab-tool-metadata").click()
  await page.getByTestId("dock-tab-new").click()
  await page.getByTestId("dock-new-tab-tool-session-sidechat").click()
  const names = () =>
    strip(page)
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim()))
  await expect.poll(names).toEqual(["Task overview", "Side chat"])

  await page
    .getByTestId("dock-tab-panel:session-sidechat")
    .dragTo(page.getByTestId("dock-tab-panel:metadata"))
  await expect.poll(names).toEqual(["Side chat", "Task overview"])

  await page.getByRole("button", { name: "Close Side chat", exact: true }).click()
  await page.getByRole("button", { name: "Close Task overview", exact: true }).click()
  await expect(dockToggle(page)).toHaveAttribute("aria-pressed", "false")
})

test("@smoke each conversation gets its own tabs and open state back", async ({ page }) => {
  await prepareConversations(page)
  await openConversation(page, "Tabs first task")
  await openDock(page)
  await page.getByTestId("dock-new-tab-tool-metadata").click()
  await expect(strip(page).getByRole("tab", { name: "Task overview", exact: true })).toBeVisible()

  // The second conversation never had the dock open: it stays shut there.
  await openConversation(page, "Tabs second task")
  await expect(dockToggle(page)).toHaveAttribute("aria-pressed", "false")

  // Back in the first, the dock and its tab are where they were left.
  await openConversation(page, "Tabs first task")
  await expect(dockToggle(page)).toHaveAttribute("aria-pressed", "true")
  await expect(
    strip(page).getByRole("tab", { name: "Task overview", exact: true })
  ).toHaveAttribute("aria-selected", "true")

  // And a dock the user closed in the first stays closed after a round trip.
  await dockToggle(page).click()
  await openConversation(page, "Tabs second task")
  await openDock(page)
  await openConversation(page, "Tabs first task")
  await expect(dockToggle(page)).toHaveAttribute("aria-pressed", "false")
})
