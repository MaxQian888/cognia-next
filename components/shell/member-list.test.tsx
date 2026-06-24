/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Character, Team } from "@/lib/claude/types"

const logInfo = jest.fn()
const logError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// `member-list` reaches lib/db/characters → the plugin registries → the plugin
// manager → lsp-registry, which calls `loggers.plugin.child(...)` at import
// time. Provide a Proxy that lazily materialises a full stub logger for ANY
// namespace (with a `.child()` that recurses) so the module graph loads no
// matter which loggers the transitive imports touch; the `ui` namespace stays
// wired to the assertion spies.
jest.mock("@/lib/logging", () => {
  const makeLogger = (): Record<string, unknown> => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: () => makeLogger(),
  })
  const cache: Record<string, unknown> = {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: jest.fn(),
      error: (...args: unknown[]) => logError(...args),
      debug: jest.fn(),
      fatal: jest.fn(),
      child: () => makeLogger(),
    },
  }
  const loggers = new Proxy(cache, {
    get: (target, prop) => {
      if (typeof prop !== "string") return Reflect.get(target, prop)
      if (!(prop in target)) target[prop] = makeLogger()
      return target[prop]
    },
  })
  return { loggers, logger: makeLogger(), createLogger: () => makeLogger() }
})

interface QueryStub<T> {
  current: T
}
const teamRef: QueryStub<Team | undefined> = { current: undefined }
const membersRef: QueryStub<Character[]> = { current: [] }
const sessionRef: QueryStub<{ scratchpad?: string } | undefined> = { current: undefined }

// useClientLiveQuery is called multiple times per render. We stub by call
// order: team, members, session.
const callQueue: Array<unknown> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_q: () => Promise<T> | T, _d: unknown[], _i: T): T => {
    const next = callQueue.shift()
    return next as unknown as T
  },
}))

interface UIStateLike {
  showMemberList: boolean
  setShowMemberList: (v: boolean) => void
  memberStatus: Record<string, string>
  scratchpadCollapsed: Record<string, boolean>
  setScratchpadCollapsed: (id: string, c: boolean) => void
  requestStopMember: (a: string, b: string) => void
}

const showMemberList = { current: true }
const memberStatus: Record<string, string> = {}
const scratchpadCollapsed: Record<string, boolean> = {}
const setShowMemberList = jest.fn((v: boolean) => {
  showMemberList.current = v
})
const setScratchpadCollapsed = jest.fn()
const requestStopMember = jest.fn()

jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(selector: (s: UIStateLike) => T): T =>
    selector({
      showMemberList: showMemberList.current,
      setShowMemberList,
      memberStatus,
      scratchpadCollapsed,
      setScratchpadCollapsed,
      requestStopMember,
    }),
}))

jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn().mockResolvedValue(undefined),
  getSession: jest.fn().mockResolvedValue(undefined),
}))

import { MemberList } from "./member-list"

function queueQueries(
  team: Team | undefined,
  members: Character[],
  session?: { scratchpad?: string }
) {
  callQueue.length = 0
  callQueue.push(team, members, session)
  teamRef.current = team
  membersRef.current = members
  sessionRef.current = session
}

const sampleTeam: Team = {
  id: "t-1",
  name: "Squad",
  members: [{ characterId: "c-1" }, { characterId: "c-2" }],
  orchestration: "round_robin",
  createdAt: 0,
  updatedAt: 0,
} as unknown as Team

const sampleMembers: Character[] = [
  { id: "c-1", name: "Alice", createdAt: 0, updatedAt: 0 } as unknown as Character,
  { id: "c-2", name: "Bob", createdAt: 0, updatedAt: 0 } as unknown as Character,
]

beforeEach(() => {
  logInfo.mockReset()
  logError.mockReset()
  setShowMemberList.mockClear().mockImplementation((v: boolean) => {
    showMemberList.current = v
  })
  setScratchpadCollapsed.mockClear()
  requestStopMember.mockClear()
  showMemberList.current = true
  for (const k of Object.keys(memberStatus)) delete memberStatus[k]
  for (const k of Object.keys(scratchpadCollapsed)) delete scratchpadCollapsed[k]
})

test("renders nothing when team or session is missing", () => {
  queueQueries(undefined, [])
  const { container } = render(
    <MemberList teamSessionId={null} teamId={null} onMention={jest.fn()} />
  )
  expect(container.firstChild).toBeNull()
})

test("collapsed view shows just a Show button which expands the rail", async () => {
  showMemberList.current = false
  queueQueries(sampleTeam, sampleMembers)
  const user = userEvent.setup()
  render(<MemberList teamSessionId="ts-1" teamId="t-1" onMention={jest.fn()} />)
  const showBtn = screen.getByLabelText("show")
  await user.click(showBtn)
  expect(setShowMemberList).toHaveBeenCalledWith(true)
  expect(logInfo).toHaveBeenCalledWith("member-list show")
})

test("renders members and clicking one fires onMention", async () => {
  queueQueries(sampleTeam, sampleMembers)
  const onMention = jest.fn()
  const user = userEvent.setup()
  render(<MemberList teamSessionId="ts-1" teamId="t-1" onMention={onMention} />)
  await user.click(screen.getByText("Alice"))
  expect(onMention).toHaveBeenCalledWith(sampleMembers[0])
  expect(logInfo).toHaveBeenCalledWith(
    "member-list mention",
    expect.objectContaining({ teamSessionId: "ts-1", characterId: "c-1" })
  )
})

test("hide button collapses the rail and logs", async () => {
  queueQueries(sampleTeam, sampleMembers)
  const user = userEvent.setup()
  render(<MemberList teamSessionId="ts-1" teamId="t-1" onMention={jest.fn()} />)
  await user.click(screen.getByLabelText("hide"))
  expect(setShowMemberList).toHaveBeenCalledWith(false)
  expect(logInfo).toHaveBeenCalledWith("member-list hide")
})

test("empty member list shows the empty-state copy", () => {
  queueQueries({ ...sampleTeam, members: [] } as unknown as Team, [])
  render(<MemberList teamSessionId="ts-1" teamId="t-1" onMention={jest.fn()} />)
  expect(screen.getByText("empty")).toBeInTheDocument()
})

test("expanded rail opts into the chat wallpaper scope", () => {
  queueQueries(sampleTeam, sampleMembers)
  render(<MemberList teamSessionId="ts-1" teamId="t-1" onMention={jest.fn()} />)
  const rail = screen.getByLabelText("label")
  expect(rail).toHaveAttribute("data-bg-target", "chat")
})

test("collapsed strip also opts into the chat wallpaper scope", () => {
  showMemberList.current = false
  queueQueries(sampleTeam, sampleMembers)
  const { container } = render(
    <MemberList teamSessionId="ts-1" teamId="t-1" onMention={jest.fn()} />
  )
  expect(container.querySelector('[data-bg-target="chat"]')).not.toBeNull()
})

test("scratchpad textarea persists on a debounce", async () => {
  jest.useFakeTimers()
  queueQueries(sampleTeam, sampleMembers, { scratchpad: "" })
  render(<MemberList teamSessionId="ts-1" teamId="t-1" onMention={jest.fn()} />)
  const ta = screen.getByPlaceholderText("notesPlaceholder") as HTMLTextAreaElement
  // Use fireEvent (rather than userEvent) since fake timers and userEvent
  // delays don't compose cleanly.
  fireEvent.change(ta, { target: { value: "remember this" } })
  jest.advanceTimersByTime(600)
  await waitFor(() => {
    const { updateSession } = jest.requireMock("@/lib/db/sessions") as { updateSession: jest.Mock }
    expect(updateSession).toHaveBeenCalledWith("ts-1", { scratchpad: "remember this" })
  })
  jest.useRealTimers()
})
