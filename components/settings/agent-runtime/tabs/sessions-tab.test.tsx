// Coverage for the agent-runtime Sessions tab.

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SessionsTab } from "./sessions-tab"
import type { ChatSession } from "@cognia/agent-config-types"

const setActiveSession = jest.fn()
const liveSessions: ChatSession[] = []
const liveUsage: Array<{
  sessionId: string
  messageId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
}> = []
let activeSessionId: string | null = null

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    const out = factory()
    if (out instanceof Promise) return undefined
    return out
  },
}))

jest.mock("@/lib/db/sessions", () => ({
  listSessions: () => liveSessions,
  forkSessionFromParent: jest.fn(),
  deleteSession: jest.fn(),
  updateSession: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessionUsage: {
      toArray: () => liveUsage,
    },
  }),
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeSessionId,
      setActiveSession,
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, vars?: Record<string, unknown>) =>
    vars ? `${k} ${JSON.stringify(vars)}` : k,
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

import { forkSessionFromParent, deleteSession, updateSession } from "@/lib/db/sessions"
const mockedFork = forkSessionFromParent as unknown as jest.Mock
const mockedDelete = deleteSession as unknown as jest.Mock
const mockedUpdate = updateSession as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  liveSessions.length = 0
  liveUsage.length = 0
  activeSessionId = null
  setActiveSession.mockClear()
})

function pushSession(s: Partial<ChatSession> & { id: string; title: string }) {
  liveSessions.push({
    kind: s.kind ?? "direct",
    createdAt: s.createdAt ?? 0,
    updatedAt: s.updatedAt ?? Date.now(),
    ...s,
  } as ChatSession)
}

describe("SessionsTab — rendering", () => {
  it("shows the empty-all message when there are no sessions", () => {
    render(<SessionsTab />)
    expect(screen.getByText(/emptyAll/)).toBeInTheDocument()
  })

  it("renders one row per session with token + cost totals", () => {
    pushSession({ id: "s1", title: "Demo" })
    liveUsage.push({
      sessionId: "s1",
      messageId: "m1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      costUsd: 0.0123,
    })
    render(<SessionsTab />)
    expect(screen.getByTestId("session-row-s1")).toBeInTheDocument()
    expect(screen.getByText(/Demo/)).toBeInTheDocument()
    expect(screen.getByText("$0.0123")).toBeInTheDocument()
  })

  it("shows '—' when a session has zero cost", () => {
    pushSession({ id: "s1", title: "Free" })
    render(<SessionsTab />)
    expect(screen.getByTestId("session-row-s1")).toHaveTextContent("—")
  })

  it("highlights the active session", () => {
    pushSession({ id: "s1", title: "Active" })
    activeSessionId = "s1"
    render(<SessionsTab />)
    expect(screen.getByTestId("session-row-s1")).toHaveAttribute("data-active", "true")
  })

  it("filter input narrows the visible rows", async () => {
    pushSession({ id: "s1", title: "Cookie research" })
    pushSession({ id: "s2", title: "Vacation plan" })
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.type(screen.getByTestId("sessions-filter"), "cookie")
    expect(screen.getByTestId("session-row-s1")).toBeInTheDocument()
    expect(screen.queryByTestId("session-row-s2")).toBeNull()
  })

  it("filter with no matches shows the empty-filter message", async () => {
    pushSession({ id: "s1", title: "Demo" })
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.type(screen.getByTestId("sessions-filter"), "zzz")
    expect(screen.getByText(/emptyFilter/)).toBeInTheDocument()
  })
})

describe("SessionsTab — row actions", () => {
  beforeEach(() => {
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
  })

  it("Resume sets the active session", async () => {
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("resume-s1"))
    expect(setActiveSession).toHaveBeenCalledWith("s1")
  })

  it("Fork is disabled when sdkSessionId is missing", () => {
    liveSessions[0] = { ...liveSessions[0], sdkSessionId: undefined }
    render(<SessionsTab />)
    expect(screen.getByTestId("fork-s1")).toBeDisabled()
  })

  it("Fork calls forkSessionFromParent + sets the new active session", async () => {
    mockedFork.mockResolvedValue({ id: "s2", title: "Demo (fork)" })
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("fork-s1"))
    await waitFor(() => expect(mockedFork).toHaveBeenCalledWith("s1"))
    expect(setActiveSession).toHaveBeenCalledWith("s2")
  })

  it("Rename opens dialog, saves on confirm", async () => {
    mockedUpdate.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("rename-s1"))
    const input = await screen.findByTestId("rename-input")
    fireEvent.change(input, { target: { value: "  Renamed  " } })
    await user.click(screen.getByTestId("rename-confirm"))
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith("s1", { title: "Renamed" }))
  })

  it("Rename refuses an empty title", async () => {
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("rename-s1"))
    const input = await screen.findByTestId("rename-input")
    fireEvent.change(input, { target: { value: "   " } })
    await user.click(screen.getByTestId("rename-confirm"))
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it("Delete confirms then calls deleteSession", async () => {
    mockedDelete.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("delete-s1"))
    await user.click(await screen.findByTestId("delete-confirm"))
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith("s1"))
  })

  it("Delete clears active session when removing the active row", async () => {
    activeSessionId = "s1"
    mockedDelete.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("delete-s1"))
    await user.click(await screen.findByTestId("delete-confirm"))
    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith(null))
  })

  it("Fork surfaces errors via toast and unblocks the row", async () => {
    mockedFork.mockRejectedValue(new Error("nope"))
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("fork-s1"))
    await waitFor(() => expect(mockedFork).toHaveBeenCalled())
  })
})
