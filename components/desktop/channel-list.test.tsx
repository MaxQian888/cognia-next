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

jest.mock("@/lib/logging", () => ({
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
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui") as Record<string, unknown>
  return {
    ...actual,
    useIsNarrow: () => isNarrow,
  }
})

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

test("shows the session-list skeleton while the first Dexie read is loading", () => {
  callQueue.push(characters, [], undefined)
  const { container } = render(
    <ChannelList
      sessions={[]}
      loading
      activeSessionId={null}
      onSelect={jest.fn()}
      onNewDirect={jest.fn()}
      onNewTeamConversation={jest.fn()}
      onDelete={jest.fn()}
      onRename={jest.fn()}
    />
  )
  // Skeleton placeholders render; the empty state must not flash during load.
  expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0)
  expect(screen.queryByText("emptyDm")).toBeNull()
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

describe("multi-select gestures", () => {
  const dmA: ChatSession = {
    id: "s-a",
    title: "Alpha",
    kind: "direct",
    characterId: "c-1",
    createdAt: 0,
    updatedAt: 30,
  } as unknown as ChatSession
  const dmB: ChatSession = {
    id: "s-b",
    title: "Bravo",
    kind: "direct",
    characterId: "c-1",
    createdAt: 0,
    updatedAt: 20,
  } as unknown as ChatSession
  const dmC: ChatSession = {
    id: "s-c",
    title: "Charlie",
    kind: "direct",
    characterId: "c-1",
    createdAt: 0,
    updatedAt: 10,
  } as unknown as ChatSession

  test("plain click activates the session via onSelect (current behavior preserved)", async () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    expect(onSelect).toHaveBeenCalledWith("s-a")
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  test("Ctrl-click toggles selection without activating the session", async () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Charlie/ }))
    await user.keyboard("{/Control}")
    expect(onSelect).not.toHaveBeenCalled()
    const toolbar = await screen.findByRole("toolbar")
    expect(toolbar.textContent).toContain(`{"count":2}`)
  })

  test("Shift-click after a plain anchor selects the range and skips activation", async () => {
    callQueue.push(characters, [], undefined)
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    expect(onSelect).toHaveBeenCalledWith("s-a")
    await user.keyboard("{Shift>}")
    await user.click(screen.getByRole("button", { name: /Charlie/ }))
    await user.keyboard("{/Shift}")
    // The plain click counted once; Shift must NOT have added a second call.
    expect(onSelect).toHaveBeenCalledTimes(1)
    const toolbar = await screen.findByRole("toolbar")
    expect(toolbar.textContent).toContain(`{"count":3}`)
  })

  test("bulk Delete fires onBulkDelete with every selected id and dismisses the toolbar", async () => {
    callQueue.push(characters, [], undefined)
    const onBulkDelete = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onBulkDelete={onBulkDelete}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")
    await user.click(screen.getByRole("button", { name: "delete" }))
    const dialog = await screen.findByRole("alertdialog")
    const dialogDelete = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "delete"
    )
    if (!dialogDelete) throw new Error("expected destructive button")
    await user.click(dialogDelete)
    expect(onBulkDelete).toHaveBeenCalledTimes(1)
    expect(onBulkDelete.mock.calls[0][0].sort()).toEqual(["s-a", "s-b"])
  })

  test("bulk Pin fires onBulkSetPinned(true, ids)", async () => {
    callQueue.push(characters, [], undefined)
    const onBulkSetPinned = jest.fn()
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onBulkSetPinned={onBulkSetPinned}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")
    await user.click(screen.getByRole("button", { name: "pin" }))
    expect(onBulkSetPinned).toHaveBeenCalledTimes(1)
    expect(onBulkSetPinned.mock.calls[0][0].sort()).toEqual(["s-a", "s-b"])
    expect(onBulkSetPinned.mock.calls[0][1]).toBe(true)
  })

  test("Escape clears the active multi-selection", async () => {
    callQueue.push(characters, [], undefined)
    const user = userEvent.setup()
    render(
      <ChannelList
        sessions={[dmA, dmB, dmC]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    await user.keyboard("{Control>}")
    await user.click(screen.getByRole("button", { name: /Alpha/ }))
    await user.click(screen.getByRole("button", { name: /Bravo/ }))
    await user.keyboard("{/Control}")
    expect(await screen.findByRole("toolbar")).toBeInTheDocument()
    // Press Escape on the container that mounted the keydown listener.
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  test("pinned-on-top sort places pinned sessions before unpinned in the DM group", () => {
    callQueue.push(characters, [], undefined)
    render(
      <ChannelList
        sessions={[
          { ...dmA, pinned: false } as ChatSession,
          { ...dmB, pinned: true } as ChatSession,
          { ...dmC, pinned: false } as ChatSession,
        ]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onNewTeamConversation={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    )
    const buttons = screen
      .getAllByRole("button")
      .filter((b) => /Alpha|Bravo|Charlie/.test(b.textContent ?? ""))
    // Bravo is pinned → must be first; the other two stay newest-first by updatedAt.
    expect(buttons[0].textContent).toMatch(/Bravo/)
    expect(buttons[1].textContent).toMatch(/Alpha/)
    expect(buttons[2].textContent).toMatch(/Charlie/)
  })
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
