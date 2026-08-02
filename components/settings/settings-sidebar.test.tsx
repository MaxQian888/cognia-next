/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

// Desktop detection reads the `__TAURI_INTERNALS__` marker directly (via
// `useDesktopAvailable`), so jsdom is already "web mode" with no mock needed.
// Tests that need the desktop-only entries call `setDesktop(true)`.
const TAURI_MARKER = "__TAURI_INTERNALS__"
function setDesktop(on: boolean) {
  if (on) {
    ;(window as unknown as Record<string, unknown>)[TAURI_MARKER] = {}
  } else {
    delete (window as unknown as Record<string, unknown>)[TAURI_MARKER]
  }
}

const save = jest.fn().mockResolvedValue(undefined)

import { useSettingsStore } from "@/stores/settings/settings-store"
import { SidebarProvider } from "@/components/ui/sidebar"
import { SettingsSidebar } from "./settings-sidebar"
import type { SettingsSectionId } from "./settings-nav-config"

interface SetupOptions {
  settings?: Partial<AppSettings>
  activeSection?: SettingsSectionId
  searchQuery?: string
  /** `false` renders the rail in its icon-collapsed state. */
  defaultOpen?: boolean
}

async function setup({
  settings = {},
  activeSection = "general",
  searchQuery = "",
  defaultOpen = true,
}: SetupOptions = {}) {
  useSettingsStore.setState({ settings: settings as never, save })
  const onSelect = jest.fn()
  const onSearchChange = jest.fn()
  const utils = render(
    <SidebarProvider defaultOpen={defaultOpen}>
      <SettingsSidebar
        activeSection={activeSection}
        onSelect={onSelect}
        searchQuery={searchQuery}
        onSearchChange={onSearchChange}
      />
    </SidebarProvider>
  )
  // `useDesktopAvailable` settles as part of the initial commit — no timer to
  // flush — but let effects (group auto-expand) drain before assertions.
  await act(async () => {})
  return { ...utils, onSelect, onSearchChange }
}

beforeEach(() => {
  save.mockClear()
})

afterEach(() => setDesktop(false))

describe("SettingsSidebar desktop-only entries", () => {
  it("hides desktop-only sections in web mode", async () => {
    await setup()
    expect(screen.queryByText("settings.tabs.subscription")).not.toBeInTheDocument()
    expect(screen.queryByText("settings.tabs.ccswitch")).not.toBeInTheDocument()
  })

  it("shows them on desktop", async () => {
    setDesktop(true)
    await setup()
    expect(screen.getByText("settings.tabs.subscription")).toBeInTheDocument()
    expect(screen.getByText("settings.tabs.ccswitch")).toBeInTheDocument()
  })
})

describe("SettingsSidebar group collapse", () => {
  it("renders all groups expanded by default", async () => {
    await setup()
    expect(screen.getByText("settings.groupAi")).toBeInTheDocument()
    expect(screen.getByText("settings.groupData")).toBeInTheDocument()
    expect(screen.getByText("settings.tabs.aiConnections")).toBeInTheDocument()
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
    expect(screen.getByText("settings.tabs.aiConnections")).toBeInTheDocument()
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

// The icon rail is only `--sidebar-width-icon` (3rem) wide while the base
// `SidebarMenuButton` forces `size-8` (2rem). Any horizontal padding or
// still-laid-out label inside that budget overflows the button's
// `overflow-hidden` box and clips the icons — these pin the icon-mode escapes.
describe("SettingsSidebar icon-collapsed rail", () => {
  async function setupCollapsed(options: SetupOptions = {}) {
    const utils = await setup({ ...options, defaultOpen: false })
    const root = utils.container.querySelector('[data-slot="sidebar"]')
    expect(root).toHaveAttribute("data-collapsible", "icon")
    return utils
  }

  it("drops the horizontal padding of the content and every group", async () => {
    const { container } = await setupCollapsed()
    expect(container.querySelector('[data-slot="sidebar-content"]')).toHaveClass(
      "group-data-[collapsible=icon]:px-0"
    )
    const groups = container.querySelectorAll('[data-slot="sidebar-group"]')
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      expect(group).toHaveClass("group-data-[collapsible=icon]:px-0")
    }
  })

  it("hides the item label and centers the icon in every menu button", async () => {
    const { container } = await setupCollapsed()
    const buttons = container.querySelectorAll('[data-slot="sidebar-menu-button"]')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button).toHaveClass("group-data-[collapsible=icon]:justify-center")
      // The label wrapper is a `div`, not the `span:last-child` the base
      // variant hides, so it needs its own icon-mode escape.
      const label = button.querySelector("div")
      expect(label).toHaveClass("group-data-[collapsible=icon]:hidden")
    }
  })

  it("makes the invisible group label inert so it cannot swallow item clicks", async () => {
    const { container } = await setupCollapsed()
    const labels = container.querySelectorAll('[data-slot="sidebar-group-label"]')
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(label).toHaveClass("group-data-[collapsible=icon]:pointer-events-none")
    }
  })

  it("hides the search field and keeps every item reachable regardless of group collapse", async () => {
    await setupCollapsed({ settings: { settingsSidebarCollapsedGroups: ["data"] } })
    expect(screen.queryByPlaceholderText("settings.searchPlaceholder")).not.toBeInTheDocument()
    expect(screen.getByText("settings.tabs.data")).toBeInTheDocument()
  })

  it("ignores group-trigger clicks instead of persisting a collapse", async () => {
    const user = userEvent.setup()
    await setupCollapsed()
    await user.click(screen.getByRole("button", { name: /settings\.groupData/ }))
    expect(save).not.toHaveBeenCalled()
  })
})
