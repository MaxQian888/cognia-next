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
  expect(screen.getByLabelText("unread.label")).toBeInTheDocument()
  // Was sidebar-menu-only until now, so Settings could not answer "where do I
  // turn the avatars off?".
  expect(screen.getByLabelText("customIcons.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.agent.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.model.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.provider.label")).toBeInTheDocument()
  expect(screen.getByLabelText("metadata.workspace.label")).toBeInTheDocument()
  expect(screen.getByLabelText("titleMotion.label")).toBeInTheDocument()
})

test("defaults: unread on, preview + compact off", () => {
  render(<ConversationSidebarCard />)
  expect(screen.getByLabelText("unread.label")).toBeChecked()
  expect(screen.getByLabelText("preview.label")).not.toBeChecked()
  expect(screen.getByLabelText("density.label")).not.toBeChecked()
  expect(screen.getByLabelText("metadata.agent.label")).toBeChecked()
  expect(screen.getByLabelText("metadata.model.label")).toBeChecked()
  expect(screen.getByLabelText("metadata.provider.label")).not.toBeChecked()
  expect(screen.getByLabelText("metadata.workspace.label")).not.toBeChecked()
  expect(screen.getByLabelText("titleMotion.label")).toBeChecked()
})

test("does not decide what the list contains — that lives in the list's toolbar", () => {
  // Grouping, sort and the search reach moved beside the rows they rearrange,
  // where a saved view can carry them. This card is about how a row *looks*.
  render(<ConversationSidebarCard />)
  expect(screen.queryByLabelText("groupBy.label")).toBeNull()
  expect(screen.queryByLabelText("sortBy.label")).toBeNull()
  expect(screen.queryByLabelText("contentSearch.label")).toBeNull()
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

test("leaves a persisted grouping or sort untouched — the toolbar still reads it", () => {
  // The entry point moved; the stored value did not. Rendering must not
  // silently rewrite settings this card no longer edits.
  settingsValue = { sortBy: "title", groupBy: "date", searchScope: "titleAndContent" }
  render(<ConversationSidebarCard />)
  expect(save).not.toHaveBeenCalled()
})

test("activity timestamps default on and can be switched off", async () => {
  const user = userEvent.setup()
  render(<ConversationSidebarCard />)
  const toggle = screen.getByLabelText("timestamps.label")
  expect(toggle).toBeChecked()
  await user.click(toggle)
  expect(save).toHaveBeenCalledWith({ conversationSidebar: { showTimestamps: false } })
})
