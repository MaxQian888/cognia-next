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
  // Was sidebar-menu-only until now, so Settings could not answer "where do I
  // turn the avatars off?".
  expect(screen.getByLabelText("customIcons.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.agent.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.model.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.provider.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.workspace.label")).toBeInTheDocument()
  expect(screen.getByLabelText("titleMotion.label")).toBeInTheDocument()
})

test("defaults: workspace grouping + unread on, preview + compact + content-search off", () => {
  render(<ConversationSidebarCard />)
  expect(screen.getByLabelText("groupBy.label")).toHaveTextContent("groupBy.options.workspace")
  expect(screen.getByLabelText("unread.label")).toBeChecked()
  expect(screen.getByLabelText("preview.label")).not.toBeChecked()
  expect(screen.getByLabelText("density.label")).not.toBeChecked()
  expect(screen.getByLabelText("contentSearch.label")).not.toBeChecked()
  expect(screen.getByLabelText("metadata.agent.label")).toBeChecked()
  expect(screen.getByLabelText("metadata.model.label")).toBeChecked()
  expect(screen.getByLabelText("metadata.provider.label")).not.toBeChecked()
  expect(screen.getByLabelText("metadata.workspace.label")).not.toBeChecked()
  expect(screen.getByLabelText("titleMotion.label")).toBeChecked()
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
  // Custom icons default on, same as the sidebar's own menu reports.
  expect(screen.getByLabelText("customIcons.label")).toBeChecked()
  await user.click(screen.getByLabelText("customIcons.label"))
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { showCustomIcons: false } })
})

test("conversation details can be added and removed without losing their order", async () => {
  settingsValue = { metadata: ["agent", "model"] }
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)

  await user.click(screen.getByLabelText("metadata.provider.label"))
  expect(save).toHaveBeenLastCalledWith({
    conversationSidebar: { metadata: ["agent", "model", "provider"] },
  })

  await user.click(screen.getByLabelText("metadata.agent.label"))
  expect(save).toHaveBeenLastCalledWith({
    conversationSidebar: { metadata: ["model"] },
  })
})

test("long-title motion can be disabled", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  await user.click(screen.getByLabelText("titleMotion.label"))
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { titleMotion: "off" } })
})

test("reset width button restores the default width", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  await user.click(screen.getByRole("button", { name: "resetWidth.button" }))
  expect(setSidebarWidth).toHaveBeenCalledWith(256)
})

test("exposes the conversation sort so mobile can reach it too", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  const trigger = screen.getByLabelText("sortBy.label")
  // Defaults to recency, matching the sidebar's own default.
  expect(trigger).toHaveTextContent("sortBy.options.recent")
  await user.click(trigger)
  await user.click(await screen.findByRole("option", { name: "sortBy.options.unread" }))
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { sortBy: "unread" } })
})

test("reflects a persisted sort choice", () => {
  settingsValue = { sortBy: "title" }
  render(<ConversationSidebarCard />)
  expect(screen.getByLabelText("sortBy.label")).toHaveTextContent("sortBy.options.title")
})

test("activity timestamps default on and can be switched off", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  const toggle = screen.getByLabelText("timestamps.label")
  expect(toggle).toBeChecked()
  await user.click(toggle)
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { showTimestamps: false } })
})
