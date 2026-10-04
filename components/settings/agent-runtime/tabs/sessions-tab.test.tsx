// Coverage for Settings → Agent Runtime → Sessions: the runtime view of
// conversations (manager entry, SDK-bound conversations, native SDK sessions).
// next-intl is globally mocked against en.json in jest.setup.ts, so the
// assertions read the shipped English strings.

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { aggregateBySession, formatBucketCost } from "@/lib/usage/session-analytics"

const liveSessions: ChatSession[] = []
const liveUsage: SessionUsageRow[] = []
let chatSlices: Record<string, { status: string }> = {}
// When true, every live query hands back a pending promise — the pre-hydration
// state the tab has to render as loading, never as an empty table.
let liveQueriesPending = false

jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (query: () => unknown) => {
    const out = query()
    return out instanceof Promise ? undefined : out
  },
}))

jest.mock("@/lib/db/sessions", () => ({
  listSessions: () => (liveQueriesPending ? Promise.resolve([]) : liveSessions),
  forkSessionFromParent: jest.fn(),
  clearSessionSdkLink: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessionUsage: {
      where: (index: string) => ({
        anyOf: (ids: string[]) => ({
          toArray: () =>
            liveQueriesPending
              ? Promise.resolve([])
              : liveUsage.filter((row) => index === "sessionId" && ids.includes(row.sessionId)),
        }),
      }),
    },
  }),
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ sessions: chatSlices }),
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock("@/components/settings/agent-runtime/sdk-session-manager", () => ({
  SdkSessionManager: () => <div data-testid="sdk-session-manager" />,
}))

const warnMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    chat: { warn: (...args: unknown[]) => warnMock(...args) },
    ui: { warn: jest.fn(), info: jest.fn() },
  },
}))

import { toast } from "sonner"
import { clearSessionSdkLink, forkSessionFromParent } from "@/lib/db/sessions"
import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"
import { SessionsTab } from "./sessions-tab"

const mockedFork = forkSessionFromParent as unknown as jest.Mock
const mockedUnlink = clearSessionSdkLink as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  liveQueriesPending = false
  liveSessions.length = 0
  liveUsage.length = 0
  chatSlices = {}
})

function pushSession(s: Partial<ChatSession> & { id: string }) {
  liveSessions.push({
    title: s.id,
    createdAt: 0,
    updatedAt: 1_000,
    ...s,
  } as ChatSession)
}

function usageRow(overrides: Partial<SessionUsageRow> & { sessionId: string }): SessionUsageRow {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    at: 1,
    model: "claude-sonnet-4-6",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.25,
    durationMs: 100,
    ...overrides,
  }
}

function renderTab() {
  return render(
    <TooltipProvider>
      <SessionsTab />
    </TooltipProvider>
  )
}

const boundBlock = () => screen.getByTestId("sdk-bound-conversations")
const managerBlock = () => screen.getByTestId("sessions-manager-entry")

describe("SessionsTab — layout", () => {
  it("stacks the manager entry, the SDK-bound list and the native SDK manager in that order", () => {
    renderTab()
    const tab = screen.getByTestId("sessions-tab")
    const order = Array.from(tab.querySelectorAll("[data-testid]"))
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) =>
        ["sessions-manager-entry", "sdk-bound-conversations", "sdk-session-manager"].includes(
          id ?? ""
        )
      )
    expect(order).toEqual([
      "sessions-manager-entry",
      "sdk-bound-conversations",
      "sdk-session-manager",
    ])
  })

  it("offers no rename, delete or resume — those live in the conversation manager", () => {
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    renderTab()
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument()
  })
})

describe("SessionsTab — conversation manager entry", () => {
  it("renders a busy region instead of counts while the session table loads", () => {
    liveQueriesPending = true
    renderTab()
    expect(managerBlock().querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByTestId("sessions-manager-active")).not.toBeInTheDocument()
  })

  it("counts exposed active and archived conversations across workspaces", () => {
    pushSession({ id: "a", projectId: "p1" })
    pushSession({ id: "b", projectId: "p2" })
    pushSession({ id: "c", archivedAt: 9 })
    pushSession({ id: "sub", kind: "subagent" })
    pushSession({ id: "wf", kind: "workflow-editor", archivedAt: 3 })
    renderTab()
    expect(screen.getByTestId("sessions-manager-active")).toHaveTextContent(
      "2 active conversations"
    )
    expect(screen.getByTestId("sessions-manager-archived")).toHaveTextContent(
      /^1 archived conversation/
    )
    expect(managerBlock().querySelector('[aria-busy="true"]')).toBeNull()
  })

  it("links to the conversation manager and its archive tab", () => {
    renderTab()
    expect(screen.getByRole("link", { name: "Open conversations" })).toHaveAttribute(
      "href",
      "/conversations"
    )
    expect(screen.getByRole("link", { name: "Open archive" })).toHaveAttribute(
      "href",
      "/conversations?tab=archived"
    )
  })
})

describe("SessionsTab — SDK-bound conversations", () => {
  it("renders a busy region, not the empty state, while loading", () => {
    liveQueriesPending = true
    renderTab()
    expect(boundBlock().querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(
      within(boundBlock()).queryByText(/No conversation is bound to an SDK session yet/)
    ).not.toBeInTheDocument()
  })

  it("explains the empty state when nothing is bound", () => {
    pushSession({ id: "plain", title: "No SDK" })
    renderTab()
    expect(
      within(boundBlock()).getByText(/No conversation is bound to an SDK session yet/)
    ).toBeInTheDocument()
    expect(screen.queryByTestId("sdk-bound-row-plain")).not.toBeInTheDocument()
  })

  it("lists only exposed SDK-bound conversations, newest activity first, archived marked", () => {
    pushSession({ id: "old", title: "Old work", sdkSessionId: "sdk-old", updatedAt: 1 })
    pushSession({
      id: "new",
      title: "New work",
      sdkSessionId: "sdk-new",
      updatedAt: 2,
      lastMessageAt: 50,
    })
    pushSession({
      id: "arch",
      title: "Shelved",
      sdkSessionId: "sdk-arch",
      updatedAt: 3,
      archivedAt: 3,
    })
    pushSession({ id: "sub", kind: "subagent", sdkSessionId: "sdk-sub", updatedAt: 99 })
    pushSession({ id: "none", title: "Unbound", updatedAt: 98 })
    renderTab()

    const rows = within(boundBlock())
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.getAttribute("data-testid"))
    expect(rows).toEqual(["sdk-bound-row-new", "sdk-bound-row-arch", "sdk-bound-row-old"])
    expect(within(screen.getByTestId("sdk-bound-row-arch")).getByText("Archived")).toBeTruthy()
    expect(within(screen.getByTestId("sdk-bound-row-new")).queryByText("Archived")).toBeNull()
    expect(within(boundBlock()).getByText(/^3 conversations/)).toBeInTheDocument()
  })

  it("shows the display title, the SDK id, the storage backend and the last activity", () => {
    pushSession({
      id: "placeholder",
      title: "New chat",
      sdkSessionId: "sdk-placeholder",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/repo" },
      updatedAt: 7_000,
    })
    pushSession({
      id: "untitled",
      title: "",
      sdkSessionId: "sdk-untitled",
      sdkSessionStorage: { backend: "filesystem" },
      updatedAt: 6_000,
    })
    pushSession({ id: "legacy", title: "Legacy", sdkSessionId: "sdk-legacy", updatedAt: 5_000 })
    renderTab()

    const placeholder = screen.getByTestId("sdk-bound-row-placeholder")
    expect(within(placeholder).getByText("New chat")).toBeInTheDocument()
    expect(within(placeholder).getByText("sdk-placeholder")).toBeInTheDocument()
    expect(within(placeholder).getByText("Host store")).toBeInTheDocument()
    expect(within(placeholder).getByText("/repo")).toBeInTheDocument()
    // The global next-intl mock renders relativeTime as the ISO instant.
    expect(within(placeholder).getByText(new Date(7_000).toISOString())).toBeInTheDocument()

    const untitled = screen.getByTestId("sdk-bound-row-untitled")
    expect(within(untitled).getByText("(untitled)")).toBeInTheDocument()
    expect(within(untitled).getByText("Local files")).toBeInTheDocument()

    // No recorded backend: say nothing rather than guess one.
    const legacy = screen.getByTestId("sdk-bound-row-legacy")
    expect(within(legacy).queryByText("Local files")).toBeNull()
    expect(within(legacy).queryByText("Host store")).toBeNull()
  })

  it("prices usage through aggregateBySession and marks a partly unpriced total", () => {
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    pushSession({ id: "s2", title: "Quiet", sdkSessionId: "sdk-2" })
    liveUsage.push(
      usageRow({ sessionId: "s1", costUsd: 0.5 }),
      usageRow({
        sessionId: "s1",
        costUsd: 0,
        model: "no-such-model-anywhere",
        providerId: "no-such-provider",
      })
    )
    renderTab()

    const [summary] = aggregateBySession(liveUsage)
    const expectedCost = formatBucketCost(summary!.costUsd, summary!.unpricedTurns, summary!.turns)
    expect(expectedCost.startsWith("≥")).toBe(true)
    const row = screen.getByTestId("sdk-bound-row-s1")
    expect(within(row).getByText(expectedCost)).toBeInTheDocument()
    expect(within(row).getByText("2")).toBeInTheDocument()
    expect(within(row).getByText("3.0K")).toBeInTheDocument()

    // No recorded turn is not "$0.00". The cost cell is the one before actions.
    const quiet = screen.getByTestId("sdk-bound-row-s2")
    const cells = within(quiet).getAllByRole("cell")
    expect(cells[cells.length - 2]).toHaveTextContent(/^—$/)
    expect(within(quiet).queryByText("$0.00")).toBeNull()
  })

  it("filters by title, chat id or SDK id and says when nothing matches", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Fix auth", sdkSessionId: "sdk-aaa" })
    pushSession({ id: "s2", title: "Write docs", sdkSessionId: "sdk-bbb" })
    renderTab()

    const input = screen.getByRole("textbox", { name: "Filter SDK-bound conversations" })
    await user.type(input, "sdk-bbb")
    expect(screen.queryByTestId("sdk-bound-row-s1")).not.toBeInTheDocument()
    expect(screen.getByTestId("sdk-bound-row-s2")).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, "nothing-like-this")
    expect(screen.getByText("No SDK-bound conversation matches this filter.")).toBeInTheDocument()
  })

  it("opens a conversation through the session link", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    renderTab()
    await user.click(screen.getByRole("button", { name: "Open “Demo”" }))
    expect(routerPush).toHaveBeenCalledWith("/?session=s1")
  })
})

describe("SessionsTab — fork SDK session", () => {
  it("forks the raw SDK session and opens the new conversation", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    mockedFork.mockResolvedValueOnce({ id: "s2", title: "Demo (fork)" })
    renderTab()

    await user.click(screen.getByRole("button", { name: "Fork the SDK session of “Demo”" }))
    await waitFor(() => expect(mockedFork).toHaveBeenCalledWith("s1"))
    expect(toast.success).toHaveBeenCalledWith("Forked into “Demo (fork)”.")
    expect(routerPush).toHaveBeenCalledWith("/?session=s2")
  })

  it("names the failure without leaking the thrown text", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    mockedFork.mockRejectedValueOnce(new Error("Cannot fork: internal detail"))
    renderTab()

    await user.click(screen.getByRole("button", { name: "Fork the SDK session of “Demo”" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't fork the SDK session."))
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("internal detail"))
    expect(warnMock).toHaveBeenCalledWith(
      "sdk-session-fork-failed",
      expect.objectContaining({ sessionId: "s1", err: "Cannot fork: internal detail" })
    )
    expect(routerPush).not.toHaveBeenCalled()
  })

  it("explains a lock that landed after render", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    mockedFork.mockRejectedValueOnce(new SessionHandoffLockedError("s1", "ticket", "branch"))
    renderTab()

    await user.click(screen.getByRole("button", { name: "Fork the SDK session of “Demo”" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This conversation is read-only while it is handed off to another device."
      )
    )
  })

  it("disables fork and unlink on a handed-off conversation with a reachable reason", () => {
    pushSession({
      id: "s1",
      title: "Demo",
      sdkSessionId: "sdk-1",
      handoffLock: { ticketId: "t1" } as ChatSession["handoffLock"],
    })
    renderTab()
    const fork = screen.getByRole("button", { name: "Fork the SDK session of “Demo”" })
    expect(fork).toBeDisabled()
    expect(fork).toHaveAccessibleDescription(
      "This conversation is read-only while it is handed off to another device."
    )
    // The tooltip hangs off a focusable wrapper, since a disabled button
    // receives neither focus nor pointer events.
    expect(screen.getByTestId("sdk-bound-fork-s1-blocked")).toHaveAttribute("tabindex", "0")
    expect(fork).not.toHaveAttribute("title")

    const unlink = screen.getByRole("button", { name: "Unlink the SDK session from “Demo”" })
    expect(unlink).toBeDisabled()
    // Opening stays available: a locked conversation can still be read.
    expect(screen.getByRole("button", { name: "Open “Demo”" })).toBeEnabled()
  })
})

describe("SessionsTab — unlink SDK session", () => {
  it("confirms, then clears the link while the conversation keeps its messages", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    mockedUnlink.mockResolvedValueOnce(undefined)
    renderTab()

    await user.click(screen.getByRole("button", { name: "Unlink the SDK session from “Demo”" }))
    const dialog = screen.getByRole("alertdialog")
    expect(dialog).toHaveTextContent("Unlink the SDK session?")
    expect(dialog).toHaveTextContent(
      "“Demo” keeps all of its messages, but its next turn starts a fresh SDK conversation instead of resuming sdk-1."
    )
    expect(mockedUnlink).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Unlink" }))
    await waitFor(() => expect(mockedUnlink).toHaveBeenCalledWith("s1"))
    expect(toast.success).toHaveBeenCalledWith("SDK session unlinked.")
  })

  it("cancelling leaves the link alone", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    renderTab()
    await user.click(screen.getByRole("button", { name: "Unlink the SDK session from “Demo”" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mockedUnlink).not.toHaveBeenCalled()
  })

  it("names an unlink failure without the thrown text", async () => {
    const user = userEvent.setup()
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    mockedUnlink.mockRejectedValueOnce(new Error("dexie exploded"))
    renderTab()
    await user.click(screen.getByRole("button", { name: "Unlink the SDK session from “Demo”" }))
    await user.click(screen.getByRole("button", { name: "Unlink" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't unlink the SDK session.")
    )
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("dexie"))
  })

  it("waits for a running turn before it can unlink", () => {
    pushSession({ id: "s1", title: "Demo", sdkSessionId: "sdk-1" })
    chatSlices = { s1: { status: "streaming" } }
    renderTab()
    const unlink = screen.getByRole("button", { name: "Unlink the SDK session from “Demo”" })
    expect(unlink).toBeDisabled()
    expect(unlink).toHaveAccessibleDescription(
      "Wait for the current turn to finish before unlinking the SDK session."
    )
    // Fork does not race the running turn's link, so it stays available.
    expect(screen.getByRole("button", { name: "Fork the SDK session of “Demo”" })).toBeEnabled()
  })
})
