/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { AgentModeSelector } from "./mode-selector"

// next-intl key passthrough — assertions match the raw translation keys.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Render dropdown content inline (radix pointer events are unreliable in
// jsdom) so the built-in / custom / team menu items are queryable + clickable.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    // `div` (not `button`) so rows that embed real action buttons
    // (edit / duplicate / delete) don't trip nested-button DOM warnings.
    <div data-testid="menu-item" role="button" tabIndex={0} onClick={onClick}>
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}))
jest.mock("./custom-mode-editor", () => ({
  CustomModeEditor: () => null,
}))
// useShallow is a passthrough so the real selector runs against our mock state.
jest.mock("zustand/react/shallow", () => ({
  useShallow: <T,>(fn: T) => fn,
}))

const customModeState = {
  customModes: {} as Record<string, unknown>,
  deleteMode: jest.fn(),
  duplicateMode: jest.fn(),
  recordModeUsage: jest.fn(),
}
jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: <T,>(selector?: (state: typeof customModeState) => T) =>
    selector ? selector(customModeState) : customModeState,
}))

const mockPluginModes: Array<Record<string, unknown>> = []
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: <T,>(
    selector: (state: {
      plugins: Record<string, { status: string; modes: typeof mockPluginModes }>
    }) => T
  ) => selector({ plugins: { work: { status: "enabled", modes: mockPluginModes } } }),
}))

let teamsState: Record<string, unknown> = {}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: { teams: Record<string, unknown> }) => unknown) =>
    selector({ teams: teamsState }),
}))
let activeProjectIdState: string | null = null
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId: activeProjectIdState }),
}))

beforeEach(() => {
  customModeState.customModes = {}
  customModeState.deleteMode.mockClear()
  customModeState.duplicateMode.mockClear()
  customModeState.recordModeUsage.mockClear()
  mockPluginModes.length = 0
  teamsState = {}
  activeProjectIdState = null
})

/** The trigger is the only button carrying the compact `text-[11px]` class. */
function getTrigger() {
  return screen
    .getAllByRole("button")
    .find((b) => b.className.includes("text-[11px]")) as HTMLElement
}

/** Click the menu row whose text content includes `text`. */
function clickMenuItemContaining(text: string) {
  const row = screen
    .getAllByTestId("menu-item")
    .find((el) => el.textContent?.includes(text)) as HTMLElement
  fireEvent.click(row)
}

describe("AgentModeSelector — trigger", () => {
  it("shows the selected built-in mode label", () => {
    render(<AgentModeSelector selectedModeId="general" onModeChange={jest.fn()} />)
    // Trigger label + the built-in list row both use the same key.
    expect(screen.getAllByText("modes.general.name").length).toBeGreaterThan(0)
  })

  it("uses the compact micro-toolbar sizing so it matches sibling composer controls", () => {
    render(<AgentModeSelector selectedModeId="general" onModeChange={jest.fn()} />)
    const trigger = getTrigger()
    expect(trigger).toBeDefined()
    expect(trigger.className).toContain("h-6")
    expect(trigger.className).toContain("text-[11px]")
    // No oversized `h-8` button / `text-sm` label anymore.
    expect(trigger.className).not.toContain("h-8")
  })

  it("falls back to the first built-in mode for an unknown id", () => {
    render(<AgentModeSelector selectedModeId="does-not-exist" onModeChange={jest.fn()} />)
    expect(screen.getAllByText("modes.general.name").length).toBeGreaterThan(0)
  })
})

describe("AgentModeSelector — selection", () => {
  it("invokes onModeChange when a built-in mode is picked", () => {
    const onModeChange = jest.fn()
    render(<AgentModeSelector selectedModeId="general" onModeChange={onModeChange} />)
    fireEvent.click(screen.getAllByTestId("menu-item")[0])
    expect(onModeChange).toHaveBeenCalledTimes(1)
  })

  it("records usage when a custom mode is picked", () => {
    customModeState.customModes = {
      "my-mode": {
        id: "my-mode",
        type: "custom",
        name: "My Mode",
        description: "A custom mode",
        icon: "Bot",
        isBuiltIn: false,
        category: "writing",
      },
    }
    const onModeChange = jest.fn()
    render(<AgentModeSelector selectedModeId="my-mode" onModeChange={onModeChange} />)
    // The selected custom mode name is shown in the trigger.
    expect(screen.getAllByText("My Mode").length).toBeGreaterThan(0)
    clickMenuItemContaining("My Mode")
    expect(onModeChange).toHaveBeenCalled()
    expect(customModeState.recordModeUsage).toHaveBeenCalledWith("my-mode")
  })

  it("renders and selects a plugin-contributed mode using its own metadata", () => {
    mockPluginModes.push({
      id: "cognia-work-mode:work",
      type: "plugin",
      name: "Work",
      description: "Create a reviewed deliverable",
      icon: "BriefcaseBusiness",
      tools: ["work_create_deliverable"],
    })
    const onModeChange = jest.fn()
    render(<AgentModeSelector selectedModeId="cognia-work-mode:work" onModeChange={onModeChange} />)

    expect(screen.getAllByText("Work").length).toBeGreaterThan(0)
    expect(screen.getByText("pluginModes")).toBeInTheDocument()
    clickMenuItemContaining("Create a reviewed deliverable")
    expect(onModeChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cognia-work-mode:work", type: "plugin" })
    )
  })
})

describe("AgentModeSelector — teams + create actions", () => {
  it("routes team selection and creation through the supplied callbacks", () => {
    teamsState = {
      "team-1": {
        id: "team-1",
        name: "Team One",
        status: "executing",
        task: "Ship it",
        teammateIds: ["a", "b"],
      },
    }
    const onSelectTeam = jest.fn()
    const onCreateTeam = jest.fn()
    render(
      <AgentModeSelector
        selectedModeId="general"
        onModeChange={jest.fn()}
        onSelectTeam={onSelectTeam}
        onCreateTeam={onCreateTeam}
      />
    )
    clickMenuItemContaining("Team One")
    expect(onSelectTeam).toHaveBeenCalledWith("team-1")

    clickMenuItemContaining("createTeam")
    expect(onCreateTeam).toHaveBeenCalledTimes(1)
  })

  it("lists only the active workspace's running teams — a workspace-less team is not grandfathered", () => {
    activeProjectIdState = "proj-A"
    teamsState = {
      mine: {
        id: "mine",
        name: "Mine Team",
        status: "executing",
        task: "t",
        teammateIds: [],
        projectId: "proj-A",
      },
      other: {
        id: "other",
        name: "Other Team",
        status: "executing",
        task: "t",
        teammateIds: [],
        projectId: "proj-B",
      },
      legacy: {
        id: "legacy",
        name: "Legacy Team",
        status: "executing",
        task: "t",
        teammateIds: [],
      },
    }
    render(
      <AgentModeSelector
        selectedModeId="general"
        onModeChange={jest.fn()}
        onSelectTeam={jest.fn()}
        onCreateTeam={jest.fn()}
      />
    )
    fireEvent.click(getTrigger())
    expect(screen.queryByText("Mine Team")).toBeInTheDocument()
    expect(screen.queryByText("Other Team")).not.toBeInTheDocument()
    expect(screen.queryByText("Legacy Team")).not.toBeInTheDocument()
  })
})
