/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Team } from "@/lib/claude/types"
import type { SelectedGuild } from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/types/shell/sidebar"

function withTooltipProvider(node: React.ReactNode) {
  return <TooltipProvider>{node}</TooltipProvider>
}

const logInfo = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerPush = jest.fn()
let pathname = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("@/lib/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
  // Pulled in transitively by the plugin extension slot → extension-api → core/logger.
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }),
}))

const teamsRef: { current: Team[] } = { current: [] }
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_query: () => Promise<T> | T, _deps: unknown[], _initial: T): T =>
    teamsRef.current as unknown as T,
}))

let selectedGuild: SelectedGuild = { kind: "dm" }
const setSelectedGuild = jest.fn((g: SelectedGuild) => {
  selectedGuild = g
})

jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: {
      selectedGuild: SelectedGuild
      setSelectedGuild: (g: SelectedGuild) => void
    }) => T
  ): T => selector({ selectedGuild, setSelectedGuild }),
}))

let platformValue: "tauri" | "mobile" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

import { GuildRail } from "./guild-rail"

const saveMock = jest.fn(
  async (_patch?: { sidebarLayout?: { pinned: string[]; hidden: string[] } }) => {}
)
const lastSavedLayout = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
  }

beforeEach(() => {
  logInfo.mockReset()
  routerPush.mockReset()
  saveMock.mockClear()
  setSelectedGuild.mockReset().mockImplementation((g: SelectedGuild) => {
    selectedGuild = g
  })
  selectedGuild = { kind: "dm" }
  teamsRef.current = []
  pathname = "/"
  platformValue = "tauri"
  // Default layout: 9 features pinned, 5 auxiliary items in "More".
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT } } as never,
      save: saveMock as never,
    })
  })
})

test("renders the DM, Canvas, and Settings rail buttons", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("directMessages")).toBeInTheDocument()
  expect(screen.getByLabelText("canvas")).toBeInTheDocument()
  expect(screen.getByLabelText("openSettings")).toBeInTheDocument()
})

test("renders a pinned rail button for every default-pinned feature", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  for (const key of [
    "workflows",
    "inbox",
    "twin",
    "discover",
    "skills",
    "plugins",
    "agentTeams",
    "scheduler",
    "goals",
  ]) {
    expect(screen.getByLabelText(key)).toBeInTheDocument()
  }
  // Auxiliary items are not pinned by default — they live behind "More".
  expect(screen.queryByLabelText("logs")).not.toBeInTheDocument()
  expect(screen.getByTestId("guild-more")).toBeInTheDocument()
})

test("the More popover lists the overflow (auxiliary) items + Customize", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  expect(screen.getByTestId("guild-more-item-logs")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-me")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-source-control")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-customize")).toBeInTheDocument()
})

test("clicking an overflow item navigates to its route", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  await user.click(screen.getByTestId("guild-more-item-logs"))
  expect(routerPush).toHaveBeenCalledWith("/logs")
})

test("the More button is hidden when nothing is in overflow", () => {
  act(() => {
    useSettingsStore.setState({
      settings: {
        sidebarLayout: {
          pinned: [...DEFAULT_SIDEBAR_LAYOUT.pinned, "observability", "logs", "me"],
          hidden: ["source-control", "performance", "eval"],
        },
      } as never,
    })
  })
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.queryByTestId("guild-more")).not.toBeInTheDocument()
})

test("opening Customize from the More popover mounts the customizer dialog", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  await user.click(screen.getByTestId("guild-more-customize"))
  expect(screen.getByTestId("sidebar-customize-dialog")).toBeInTheDocument()
  expect(screen.getByTestId("sidebar-customizer")).toBeInTheDocument()
})

test("right-click context menu can hide a pinned item", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  fireEvent.contextMenu(screen.getByLabelText("workflows"))
  // Context menu item label keys are returned verbatim by the i18n mock.
  fireEvent.click(screen.getByText("customize.hideItem"))
  const saved = lastSavedLayout()
  expect(saved.pinned).not.toContain("workflows")
  expect(saved.hidden).toContain("workflows")
})

test("right-click context menu can move a pinned item to More", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  fireEvent.contextMenu(screen.getByLabelText("inbox"))
  fireEvent.click(screen.getByText("customize.moveToMore"))
  const saved = lastSavedLayout()
  expect(saved.pinned).not.toContain("inbox")
  expect(saved.hidden).not.toContain("inbox")
})

test("right-click context menu can open the full customizer", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  fireEvent.contextMenu(screen.getByLabelText("workflows"))
  fireEvent.click(screen.getByText("customize.title"))
  expect(screen.getByTestId("sidebar-customize-dialog")).toBeInTheDocument()
})

test("the More button reflects the active state when on an overflow route", () => {
  pathname = "/logs"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByTestId("guild-more")).toHaveClass("bg-primary/10")
})

test("a selected team button shows the active boxShadow when on the home route", () => {
  teamsRef.current = [
    {
      id: "t-1",
      name: "Alpha",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
  ] as unknown as Team[]
  selectedGuild = { kind: "team", teamId: "t-1" }
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("Alpha")).toHaveAttribute("aria-current", "page")
})

test("clicking DM/team from a feature route routes back to /", async () => {
  pathname = "/workflows"
  teamsRef.current = [
    {
      id: "t-1",
      name: "Alpha",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
  ] as unknown as Team[]
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("directMessages"))
  expect(routerPush).toHaveBeenCalledWith("/")
  routerPush.mockClear()
  await user.click(screen.getByLabelText("Alpha"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
  expect(routerPush).toHaveBeenCalledWith("/")
})

test("hides desktop-only overflow items on mobile but keeps the rest in More", async () => {
  platformValue = "mobile"
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  expect(screen.queryByTestId("guild-more-item-performance")).not.toBeInTheDocument()
  expect(screen.queryByTestId("guild-more-item-source-control")).not.toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-logs")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-me")).toBeInTheDocument()
})

test("clicking DM/Canvas updates the guild selection and logs", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("canvas"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
  expect(logInfo).toHaveBeenCalledWith("guild switch canvas")
  await user.click(screen.getByLabelText("directMessages"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
})

test("clicking a chat guild while on a feature route also pushes back to /", async () => {
  pathname = "/workflows"
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("canvas"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
  expect(routerPush).toHaveBeenCalledWith("/")
})

test("clicking a feature button routes to its top-level path", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("workflows"))
  expect(routerPush).toHaveBeenCalledWith("/workflows")
  expect(logInfo).toHaveBeenCalledWith(
    "guild navigate feature",
    expect.objectContaining({ route: "/workflows" })
  )
  await user.click(screen.getByLabelText("inbox"))
  expect(routerPush).toHaveBeenCalledWith("/inbox")
})

test("active state highlights the current route", () => {
  pathname = "/workflows/abc/edit"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("workflows")).toHaveAttribute("aria-current", "page")
  expect(screen.getByLabelText("inbox")).not.toHaveAttribute("aria-current")
})

test("renders one button per team and selecting one switches guild", async () => {
  teamsRef.current = [
    {
      id: "t-1",
      name: "Alpha",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "t-2",
      name: "Beta",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
  ] as unknown as Team[]
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("Alpha"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
  expect(logInfo).toHaveBeenCalledWith("guild switch team", { teamId: "t-1" })
})

test("clicking Create team and Settings invoke the props and log", async () => {
  const onCreateTeam = jest.fn()
  const onOpenSettings = jest.fn()
  const user = userEvent.setup()
  render(
    withTooltipProvider(<GuildRail onCreateTeam={onCreateTeam} onOpenSettings={onOpenSettings} />)
  )
  await user.click(screen.getByLabelText("createTeam"))
  expect(onCreateTeam).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("guild create team click")
  await user.click(screen.getByLabelText("openSettings"))
  expect(onOpenSettings).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("guild open settings")
})
