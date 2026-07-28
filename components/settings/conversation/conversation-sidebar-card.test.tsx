/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ConversationSidebarSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let settingsValue: ConversationSidebarSettings | null = null
const save = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: unknown }) => T): T =>
    selector({ settings: settingsValue ? { conversationSidebar: settingsValue } : null, save }),
}))

const setSidebarWidth = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: { setSidebarWidth: unknown }) => T): T =>
    selector({ setSidebarWidth }),
  SIDEBAR_WIDTH_DEFAULT: 256,
}))

import { ConversationSidebarCard } from "./conversation-sidebar-card"

beforeEach(() => {
  settingsValue = null
  save.mockReset()
  setSidebarWidth.mockReset()
})

test("groups the sidebar behavior controls under one card", () => {
  render(<ConversationSidebarCard />)
  expect(screen.getByLabelText("density.label")).toBeInTheDocument()
  expect(screen.getByLabelText("preview.label")).toBeInTheDocument()
  expect(screen.getByLabelText("groupBy.label")).toBeInTheDocument()
  expect(screen.getByLabelText("unread.label")).toBeInTheDocument()
  expect(screen.getByLabelText("contentSearch.label")).toBeInTheDocument()
})

test("defaults: workspace grouping + unread on, preview + compact + content-search off", () => {
  render(<ConversationSidebarCard />)
  expect(screen.getByLabelText("groupBy.label")).toHaveTextContent("groupBy.options.workspace")
  expect(screen.getByLabelText("unread.label")).toBeChecked()
  expect(screen.getByLabelText("preview.label")).not.toBeChecked()
  expect(screen.getByLabelText("density.label")).not.toBeChecked()
  expect(screen.getByLabelText("contentSearch.label")).not.toBeChecked()
})

test("folds the retired groupByDate=false into the no-grouping option", () => {
  settingsValue = { groupByDate: false }
  render(<ConversationSidebarCard />)
  expect(screen.getByLabelText("groupBy.label")).toHaveTextContent("groupBy.options.none")
})

test("picking a grouping axis saves it without dropping siblings", async () => {
  settingsValue = { showPreview: true }
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  await user.click(screen.getByLabelText("groupBy.label"))
  await user.click(screen.getByRole("option", { name: "groupBy.options.date" }))
  expect(save).toHaveBeenCalledWith({
    conversationSidebar: { showPreview: true, groupBy: "date" },
  })
})

test("enabling content search saves searchScope=titleAndContent", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  await user.click(screen.getByLabelText("contentSearch.label"))
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { searchScope: "titleAndContent" } })
})

test("enabling compact density saves density=compact and merges existing settings", async () => {
  settingsValue = { showPreview: true }
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  await user.click(screen.getByLabelText("density.label"))
  expect(save).toHaveBeenCalledWith({
    conversationSidebar: { showPreview: true, density: "compact" },
  })
})

test("reflects a persisted compact density as checked", () => {
  settingsValue = { density: "compact" }
  render(<ConversationSidebarCard />)
  expect(screen.getByLabelText("density.label")).toBeChecked()
})

test("each behavior toggle saves its matching field", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  await user.click(screen.getByLabelText("preview.label"))
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { showPreview: true } })
  // Defaults are on → clicking turns them off.
  await user.click(screen.getByLabelText("unread.label"))
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { showUnreadBadges: false } })
})

test("reset width button restores the default width", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  await user.click(screen.getByRole("button", { name: "resetWidth.button" }))
  expect(setSidebarWidth).toHaveBeenCalledWith(256)
})
