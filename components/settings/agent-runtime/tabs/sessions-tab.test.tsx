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

// When true, both live queries hand back a pending promise — the pre-hydration
// state the component has to survive without rows.
let liveQueriesPending = false
jest.mock("@/lib/db/sessions", () => ({
  listSessions: () => (liveQueriesPending ? Promise.resolve([]) : liveSessions),
  forkSessionFromParent: jest.fn(),
  deleteSession: jest.fn(),
  updateSession: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessionUsage: {
      toArray: () => (liveQueriesPending ? Promise.resolve([]) : liveUsage),
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

jest.mock("@/components/settings/agent-runtime/sdk-session-manager", () => ({
  SdkSessionManager: () => <div data-testid="sdk-session-manager" />,
}))

const warnMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { chat: { warn: (...args: unknown[]) => warnMock(...args) } },
}))

import { toast } from "sonner"
import { forkSessionFromParent, deleteSession, updateSession } from "@/lib/db/sessions"
const mockedFork = forkSessionFromParent as unknown as jest.Mock
const mockedDelete = deleteSession as unknown as jest.Mock
const mockedUpdate = updateSession as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  liveQueriesPending = false
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

  it("Fork failure shows a translated toast, not the raw Error text", async () => {
    // `forkSessionFromParent` throws a bare English Error when the parent has
    // no `sdkSessionId` — always the case for providers that never issue one.
    // Surfacing `err.message` put untranslated internals in front of the user.
    mockedFork.mockRejectedValue(new Error("session s1 has no sdkSessionId"))
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("fork-s1"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("forkFailedToast"))
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("sdkSessionId"))
    expect(setActiveSession).not.toHaveBeenCalled()
  })

  it("Fork failure still records the real reason for diagnosis", async () => {
    mockedFork.mockRejectedValue(new Error("session s1 has no sdkSessionId"))
    const user = userEvent.setup()
    render(<SessionsTab />)
    await user.click(screen.getByTestId("fork-s1"))
    await waitFor(() =>
      expect(warnMock).toHaveBeenCalledWith(
        "sdk-session-fork-failed",
        expect.objectContaining({ sessionId: "s1" })
      )
    )
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

  it("Rename can be dismissed with Cancel and with Escape", async () => {
    const user = userEvent.setup()
    render(<SessionsTab />)

    await user.click(screen.getByTestId("rename-s1"))
    await user.click(await screen.findByRole("button", { name: "cancel" }))
    await waitFor(() => expect(screen.queryByTestId("rename-input")).not.toBeInTheDocument())

    await user.click(screen.getByTestId("rename-s1"))
    await screen.findByTestId("rename-input")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByTestId("rename-input")).not.toBeInTheDocument())
  })

  it("falls back to placeholders for an untitled, kindless row", () => {
    liveSessions.push({ id: "bare", title: "", updatedAt: Date.now(), createdAt: 0 } as never)
    render(<SessionsTab />)
    const row = screen.getByTestId("session-row-bare")
    expect(row).toHaveTextContent("untitled")
    expect(row).toHaveTextContent("direct")
  })

  it("labels each age band of the Updated column", () => {
    const now = Date.now()
    pushSession({ id: "now", title: "Now", updatedAt: now })
    pushSession({ id: "mins", title: "Mins", updatedAt: now - 5 * 60_000 })
    pushSession({ id: "hours", title: "Hours", updatedAt: now - 5 * 3_600_000 })
    pushSession({ id: "days", title: "Days", updatedAt: now - 5 * 86_400_000 })
    render(<SessionsTab />)

    expect(screen.getByTestId("session-row-now")).toHaveTextContent("ago.justNow")
    expect(screen.getByTestId("session-row-mins")).toHaveTextContent("ago.minutes")
    expect(screen.getByTestId("session-row-hours")).toHaveTextContent("ago.hours")
    expect(screen.getByTestId("session-row-days")).toHaveTextContent("ago.days")
  })

  it("names an untitled session by its id in the resume toast", async () => {
    const user = userEvent.setup()
    liveSessions.push({ id: "bare", title: "", updatedAt: Date.now(), createdAt: 0 } as never)
    render(<SessionsTab />)
    await user.click(screen.getByTestId("resume-bare"))
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("bare"))
  })

  it("surfaces a rename failure and unblocks the row", async () => {
    const user = userEvent.setup()
    mockedUpdate.mockRejectedValueOnce(new Error("write refused"))
    render(<SessionsTab />)

    await user.click(screen.getByTestId("rename-s1"))
    fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "New" } })
    await user.click(screen.getByTestId("rename-confirm"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("write refused"))
  })

  it("surfaces a delete failure and keeps the row", async () => {
    const user = userEvent.setup()
    mockedDelete.mockRejectedValueOnce("boom")
    render(<SessionsTab />)

    await user.click(screen.getByTestId("delete-s1"))
    await user.click(await screen.findByTestId("delete-confirm"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"))
    expect(screen.getByTestId("session-row-s1")).toBeInTheDocument()
  })

  it("renders the empty state while both live queries are still pending", () => {
    liveQueriesPending = true
    render(<SessionsTab />)
    expect(screen.getByText(/emptyAll/)).toBeInTheDocument()
  })

  it("stringifies a non-Error rename failure", async () => {
    const user = userEvent.setup()
    mockedUpdate.mockRejectedValueOnce("rename blew up")
    render(<SessionsTab />)

    await user.click(screen.getByTestId("rename-s1"))
    fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "New" } })
    await user.click(screen.getByTestId("rename-confirm"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("rename blew up"))
  })

  it("reads the message off an Error delete failure", async () => {
    const user = userEvent.setup()
    mockedDelete.mockRejectedValueOnce(new Error("delete refused"))
    render(<SessionsTab />)

    await user.click(screen.getByTestId("delete-s1"))
    await user.click(await screen.findByTestId("delete-confirm"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("delete refused"))
  })
})
