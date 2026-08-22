/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockKey: string | null = "ck1"
let mockMessageId: string | null = null

const mockRouterPush = jest.fn()
const mockNotFound = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
  useSearchParams: () => ({
    get: (k: string) => (k === "key" ? mockKey : k === "messageId" ? mockMessageId : null),
  }),
  usePathname: () => "/inbox/c",
  redirect: jest.fn(),
  notFound: (...args: unknown[]) => mockNotFound(...args),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
const mockJump = jest.fn(async (..._a: unknown[]) => true)
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: (...a: unknown[]) => mockJump(...a),
}))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: jest.fn().mockResolvedValue({}),
}))

// Stub the heavy sub-components so we only test the route's own logic.
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="inbox-shell">{children}</div>
  ),
}))

jest.mock("@/components/inbox/conversation-header", () => ({
  ConversationHeader: ({ title }: { title: string }) => (
    <div data-testid="conversation-header">{title}</div>
  ),
}))

jest.mock("@/components/inbox/history-load-earlier", () => ({
  HistoryLoadEarlier: ({
    conversationKey,
    adapterId,
  }: {
    conversationKey: string
    adapterId: string
  }) => (
    <div data-testid="history-load-earlier" data-key={conversationKey} data-adapter={adapterId} />
  ),
}))

// Capture ChatPane props so the route's send/stop/regenerate wiring is testable.
let lastChatPaneProps: Record<string, unknown> | null = null
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: (props: Record<string, unknown>) => {
    lastChatPaneProps = props
    return <div data-testid="chat-pane-stub" />
  },
}))

jest.mock("@/components/chat/use-resolved-connector-mode", () => ({
  useResolvedConnectorMode: () => "auto",
}))

const mockSelect = jest.fn()
const directChat = {
  send: jest.fn(),
  stop: jest.fn(),
  regenerate: jest.fn(),
  editAndResend: jest.fn(),
}
const teamChat = {
  send: jest.fn(),
  stop: jest.fn(),
  regenerate: jest.fn(),
  editAndResend: jest.fn(),
}
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({ select: mockSelect }),
  useClaudeChat: () => directChat,
  useTeamChat: () => teamChat,
}))

import type { ChatSession } from "@cognia/agent-config-types"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

let mockSession: ChatSession | null | undefined = undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockSession),
}))

// The bot row behind the conversation. Mocked separately from the session
// live-query because "load earlier" is gated on what THIS instance can do:
// `undefined` means the row has not resolved yet, which must still answer from
// the platform table rather than hiding the control.
let mockAdapterRow: AdapterInstanceRow | undefined = undefined
jest.mock("@/hooks/connectors/use-adapter-instance", () => ({
  useAdapterInstance: () => mockAdapterRow,
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import ConversationPage from "./page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function makeSession(
  id: string,
  ck: string,
  platform = "telegram",
  extra: Partial<ChatSession> = {}
): ChatSession {
  return {
    ...extra,
    id,
    title: "Bot chat",
    kind: (extra as { kind?: string }).kind ?? "direct",
    createdAt: 1000,
    updatedAt: 2000,
    platformBinding: {
      adapterId: "a1",
      conversationKey: ck,
      platform,
      conversationRef: { platform, adapterId: "a1" },
    },
  } as unknown as ChatSession
}

describe("ConversationPage (/inbox/c?key=)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSession = undefined
    mockAdapterRow = undefined
    mockKey = "ck1"
    mockMessageId = null
    lastChatPaneProps = null
    mockJump.mockResolvedValue(true)
  })

  it("calls notFound when the key query param is missing", () => {
    mockKey = null
    render(<ConversationPage />)
    expect(mockNotFound).toHaveBeenCalled()
  })

  it("calls notFound when no session matches the key", () => {
    // The real `notFound()` throws to abort rendering; mirror that so the
    // route does not fall through to the platform-bound branch.
    // (React replays a throwing render once, so the throw must persist.)
    mockNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND")
    })
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      mockSession = null
      expect(() => render(<ConversationPage />)).toThrow("NEXT_NOT_FOUND")
      expect(mockNotFound).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      mockNotFound.mockReset()
    }
  })

  it("wires the direct-chat handlers into ChatPane for a direct session", () => {
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage />)
    const props = lastChatPaneProps!
    expect(props.showHeader).toBe(false)
    ;(props.onSend as (c: string, m?: unknown[]) => void)("hi", [{ id: "att" }])
    expect(directChat.send).toHaveBeenCalledWith("hi", undefined, {
      attachmentManifest: [{ id: "att" }],
    })
    expect(teamChat.send).not.toHaveBeenCalled()
    expect(props.onStop).toBe(directChat.stop)
    expect(props.onRegenerate).toBe(directChat.regenerate)
    expect(props.onEditResend).toBe(directChat.editAndResend)
    ;(props.onUseSample as (t: string) => void)("sample")
    expect(directChat.send).toHaveBeenCalledWith("sample")
    ;(props.onCreate as () => void)()
    ;(props.onOpenSettings as (tab?: string) => void)("connections")
    expect(mockRouterPush).toHaveBeenCalledWith("/settings?section=connections")
    ;(props.onOpenSettings as (tab?: string) => void)()
    expect(mockRouterPush).toHaveBeenCalledWith("/settings")
  })

  it("wires the team-chat handlers into ChatPane for a team session", () => {
    mockSession = makeSession("s2", "ck1", "telegram", {
      kind: "team",
      teamId: "team-1",
    } as Partial<ChatSession>)
    render(<ConversationPage />)
    const props = lastChatPaneProps!
    ;(props.onSend as (c: string, m?: unknown[]) => void)("go")
    expect(teamChat.send).toHaveBeenCalledWith("go", { attachmentManifest: undefined })
    expect(directChat.send).not.toHaveBeenCalled()
    expect(props.onStop).toBe(teamChat.stop)
    expect(props.onRegenerate).toBe(teamChat.regenerate)
    expect(props.onEditResend).toBe(teamChat.editAndResend)
    ;(props.onUseSample as (t: string) => void)("sample")
    expect(teamChat.send).toHaveBeenCalledWith("sample")
  })

  it("renders InboxShell in loading state when session is undefined", () => {
    mockSession = undefined
    render(<ConversationPage />)
    expect(screen.getByTestId("inbox-shell")).toBeInTheDocument()
    expect(screen.getByText("Loading…")).toBeInTheDocument()
  })

  it("renders conversation header when session found", () => {
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage />)
    expect(screen.getByTestId("conversation-header")).toBeInTheDocument()
    expect(screen.getByText("Bot chat")).toBeInTheDocument()
  })

  it("renders conversation detail pane when session found", () => {
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage />)
    expect(screen.getByTestId("conversation-detail")).toBeInTheDocument()
  })

  it("mounts ChatPane in the detail pane", () => {
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage />)
    expect(screen.getByTestId("chat-pane-stub")).toBeInTheDocument()
  })

  it("selects the resolved session so the chat store binds to it", () => {
    mockSelect.mockClear()
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage />)
    expect(mockSelect).toHaveBeenCalledWith("s1")
  })

  it("jumps to the linked message once the session resolves (?messageId=)", async () => {
    mockMessageId = "m-42"
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage />)
    await waitFor(() => expect(mockJump).toHaveBeenCalledWith("s1", "m-42", { align: "center" }))
    // Selection precedes the jump so the pane that owns the list is the target.
    expect(mockSelect.mock.invocationCallOrder[0]).toBeLessThan(
      mockJump.mock.invocationCallOrder[0]!
    )
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it("does not jump without a messageId, and reports a jump that never landed", async () => {
    mockSession = makeSession("s1", "ck1")
    const { unmount } = render(<ConversationPage />)
    await act(async () => {})
    expect(mockJump).not.toHaveBeenCalled()
    unmount()
    mockMessageId = "stale"
    mockJump.mockResolvedValueOnce(false)
    render(<ConversationPage />)
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("The linked message could not be opened.")
    )
  })

  it("ignores a jump result that arrives after the route moved on", async () => {
    mockMessageId = "m-1"
    mockSession = makeSession("s1", "ck1")
    let finish!: (landed: boolean) => void
    mockJump.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)))
    const { unmount } = render(<ConversationPage />)
    await waitFor(() => expect(mockJump).toHaveBeenCalled())
    unmount()
    await act(async () => finish(false))
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it("mounts HistoryLoadEarlier under the header for a history.fetch-capable platform", () => {
    mockSession = makeSession("s1", "ck1", "slack")
    render(<ConversationPage />)
    const bar = screen.getByTestId("history-load-earlier")
    expect(bar).toHaveAttribute("data-key", "ck1")
    expect(bar).toHaveAttribute("data-adapter", "a1")
    // Directly below the header, inside the detail column.
    const detail = screen.getByTestId("conversation-detail")
    const header = screen.getByTestId("conversation-header")
    expect(detail.contains(bar)).toBe(true)
    expect(header.nextElementSibling).toBe(bar)
  })

  it("hides HistoryLoadEarlier when THIS Slack install was never granted a history scope", () => {
    // The platform declares `history.fetch`; this workspace's OAuth grant does
    // not carry it, so the button would only ever produce `missing_scope`.
    mockSession = makeSession("s1", "ck1", "slack")
    mockAdapterRow = {
      id: "a1",
      type: "slack",
      settings: { connectedScopes: { scopes: ["chat:write"], grantedAtMs: 1 } },
    } as unknown as AdapterInstanceRow
    render(<ConversationPage />)
    expect(screen.queryByTestId("history-load-earlier")).toBeNull()
  })

  it("keeps HistoryLoadEarlier when the grant does carry a history scope", () => {
    mockSession = makeSession("s1", "ck1", "slack")
    mockAdapterRow = {
      id: "a1",
      type: "slack",
      settings: {
        connectedScopes: { scopes: ["chat:write", "channels:history"], grantedAtMs: 1 },
      },
    } as unknown as AdapterInstanceRow
    render(<ConversationPage />)
    expect(screen.getByTestId("history-load-earlier")).toBeTruthy()
  })

  it("does not mount HistoryLoadEarlier when the platform lacks history.fetch", () => {
    // Telegram's Bot API has no history endpoint, so its capability list
    // deliberately omits `history.fetch`.
    mockSession = makeSession("s1", "ck1", "telegram")
    render(<ConversationPage />)
    expect(screen.queryByTestId("history-load-earlier")).not.toBeInTheDocument()
  })
})
