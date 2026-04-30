/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Character, ChatSession, Team } from "@/lib/claude/types"
import type { SelectedGuild } from "@/stores/ui"

const logInfo = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
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

const callQueue: Array<unknown> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_q: () => Promise<T> | T, _d: unknown[], _i: T): T =>
    (callQueue.shift() ?? _i) as unknown as T,
}))

let selectedGuild: SelectedGuild = { kind: "dm" }
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: { selectedGuild: SelectedGuild }) => T): T =>
    selector({ selectedGuild }),
}))

let isNarrow = false
jest.mock("@/hooks/ui", () => ({
  useIsNarrow: () => isNarrow,
}))

import { ChannelList } from "./channel-list"

const characters: Character[] = [
  { id: "c-1", name: "Alice", createdAt: 0, updatedAt: 0 } as unknown as Character,
]
const team: Team = {
  id: "t-1",
  name: "Squad",
  members: [],
  orchestration: "round_robin",
  createdAt: 0,
  updatedAt: 0,
} as unknown as Team

const dmSession: ChatSession = {
  id: "s-1",
  title: "Hi Alice",
  kind: "direct",
  characterId: "c-1",
  createdAt: 0,
  updatedAt: 0,
} as unknown as ChatSession
const teamSession: ChatSession = {
  id: "s-2",
  title: "Squad meeting",
  kind: "team",
  teamId: "t-1",
  createdAt: 0,
  updatedAt: 0,
} as unknown as ChatSession

beforeEach(() => {
  logInfo.mockReset()
  callQueue.length = 0
  selectedGuild = { kind: "dm" }
  isNarrow = false
})

test("DM guild renders only direct sessions grouped by character", () => {
  // queries: characters, sessionStates (none), team (none)
  callQueue.push(characters, [], undefined)
  render(
    <ChannelList
      sessions={[dmSession, teamSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  expect(screen.getByText("directMessages")).toBeInTheDocument()
  expect(screen.getByText("Hi Alice")).toBeInTheDocument()
  expect(screen.queryByText("Squad meeting")).toBeNull()
})

test("Team guild renders only that team's sessions", () => {
  selectedGuild = { kind: "team", teamId: "t-1" }
  callQueue.push(characters, [], team)
  render(
    <ChannelList
      sessions={[dmSession, teamSession]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  expect(screen.getByText("Squad")).toBeInTheDocument()
  expect(screen.getByText("Squad meeting")).toBeInTheDocument()
  expect(screen.queryByText("Hi Alice")).toBeNull()
})

test("Empty DM bucket shows the DM empty state", () => {
  callQueue.push(characters, [], undefined)
  render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  expect(screen.getByText("emptyDm")).toBeInTheDocument()
})

test("New chat button on DM guild calls onNewDirect", async () => {
  callQueue.push(characters, [], undefined)
  const onNewDirect = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={onNewDirect}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.click(screen.getByLabelText("newChat"))
  expect(onNewDirect).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("channel-list new-direct")
})

test("New conversation button on team guild routes to onNewTeamConversation with teamId", async () => {
  selectedGuild = { kind: "team", teamId: "t-1" }
  callQueue.push(characters, [], team)
  const onNew = jest.fn()
  const user = userEvent.setup()
  render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={onNew}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  await user.click(screen.getByLabelText("newConversation"))
  expect(onNew).toHaveBeenCalledWith("t-1")
})

test("Canvas guild renders nothing (canvas has its own rail)", () => {
  selectedGuild = { kind: "canvas" }
  // No queries are consumed because the body returns null early.
  callQueue.push(characters, [], undefined)
  const { container } = render(
    <ChannelList
      sessions={[]}
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  // The aside renders but its body short-circuits to null.
  expect(container.querySelector("aside")?.textContent).toBe("")
})
