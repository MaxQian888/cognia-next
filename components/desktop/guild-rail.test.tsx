/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Team } from "@/lib/claude/types"
import type { SelectedGuild } from "@/stores/ui"

function withTooltipProvider(node: React.ReactNode) {
  return <TooltipProvider>{node}</TooltipProvider>
}

const logInfo = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
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

import { GuildRail } from "./guild-rail"

beforeEach(() => {
  logInfo.mockReset()
  setSelectedGuild.mockReset().mockImplementation((g: SelectedGuild) => {
    selectedGuild = g
  })
  selectedGuild = { kind: "dm" }
  teamsRef.current = []
})

test("renders the DM, Canvas, and Settings rail buttons", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("directMessages")).toBeInTheDocument()
  expect(screen.getByLabelText("canvas")).toBeInTheDocument()
  expect(screen.getByLabelText("openSettings")).toBeInTheDocument()
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
