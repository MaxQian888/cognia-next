/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@/lib/claude/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

const save = jest.fn().mockResolvedValue(undefined)

import { useSettingsStore } from "@/stores/settings/settings-store"
import { SidebarProvider } from "@/components/ui/sidebar"
import { SettingsSidebar } from "./settings-sidebar"
import type { SettingsSectionId } from "./settings-nav-config"

interface SetupOptions {
  settings?: Partial<AppSettings>
  activeSection?: SettingsSectionId
  searchQuery?: string
}

async function setup({
  settings = {},
  activeSection = "general",
  searchQuery = "",
}: SetupOptions = {}) {
  useSettingsStore.setState({ settings: settings as never, save })
  const onSelect = jest.fn()
  const onSearchChange = jest.fn()
  const utils = render(
    <SidebarProvider>
      <SettingsSidebar
        activeSection={activeSection}
        onSelect={onSelect}
        searchQuery={searchQuery}
        onSearchChange={onSearchChange}
      />
    </SidebarProvider>
  )
  // Flush the deferred `isTauri()` detection (setTimeout 0) inside act.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { ...utils, onSelect, onSearchChange }
}

beforeEach(() => {
  save.mockClear()
})

describe("SettingsSidebar group collapse", () => {
  it("renders all groups expanded by default", async () => {
    await setup()
    expect(screen.getByText("settings.groupAi")).toBeInTheDocument()
    expect(screen.getByText("settings.groupData")).toBeInTheDocument()
    expect(screen.getByText("settings.tabs.general")).toBeInTheDocument()
    expect(screen.getByText("settings.tabs.data")).toBeInTheDocument()
  })

  it("collapsing a group via its label persists through save()", async () => {
    const user = userEvent.setup()
    await setup()
    await user.click(screen.getByRole("button", { name: /settings\.groupData/ }))
    expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: ["data"] })
  })

  it("hides the items of a group collapsed in settings", async () => {
    await setup({ settings: { settingsSidebarCollapsedGroups: ["data"] } })
    expect(screen.queryByText("settings.tabs.data")).not.toBeInTheDocument()
    expect(screen.queryByText("settings.tabs.workflows")).not.toBeInTheDocument()
    // Other groups stay expanded.
    expect(screen.getByText("settings.tabs.general")).toBeInTheDocument()
  })

  it("expanding a collapsed group persists the removal", async () => {
    const user = userEvent.setup()
    await setup({ settings: { settingsSidebarCollapsedGroups: ["data"] } })
    await user.click(screen.getByRole("button", { name: /settings\.groupData/ }))
    expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: [] })
  })

  it("forces collapsed groups open while searching", async () => {
    // "theme" matches the appearance section inside the collapsed interface group.
    await setup({
      settings: { settingsSidebarCollapsedGroups: ["interface"] },
      searchQuery: "theme",
    })
    expect(screen.getByText("settings.tabs.appearance")).toBeInTheDocument()
    // The group trigger is inert during search.
    expect(screen.getByRole("button", { name: /settings\.groupInterface/ })).toBeDisabled()
    // Search never rewrites the persisted collapse state.
    expect(save).not.toHaveBeenCalled()
  })

  it("auto-expands the group containing the active section", async () => {
    await setup({
      settings: { settingsSidebarCollapsedGroups: ["system"] },
      activeSection: "about",
    })
    expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: [] })
  })

  it("does not undo a manual collapse of the active section's group", async () => {
    const user = userEvent.setup()
    await setup({ activeSection: "general" })
    await user.click(screen.getByRole("button", { name: /settings\.groupAi/ }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ settingsSidebarCollapsedGroups: ["ai"] })
  })
})
