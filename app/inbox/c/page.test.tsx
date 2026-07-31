/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockKey: string | null = "ck1"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => ({ get: (k: string) => (k === "key" ? mockKey : null) }),
  usePathname: () => "/inbox/c",
  redirect: jest.fn(),
  notFound: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
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

jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: () => <div data-testid="chat-pane-stub" />,
}))

jest.mock("@/components/chat/use-resolved-connector-mode", () => ({
  useResolvedConnectorMode: () => "auto",
}))

const mockSelect = jest.fn()
jest.mock("@/hooks/chat", () => ({
  useSessions: () => ({ select: mockSelect }),
  useClaudeChat: () => ({
    send: jest.fn(),
    stop: jest.fn(),
    regenerate: jest.fn(),
    editAndResend: jest.fn(),
  }),
  useTeamChat: () => ({
    send: jest.fn(),
    stop: jest.fn(),
    regenerate: jest.fn(),
    editAndResend: jest.fn(),
  }),
}))

import type { ChatSession } from "@cognia/agent-config-types"

let mockSession: ChatSession | null | undefined = undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockSession),
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import ConversationPage from "./page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function makeSession(id: string, ck: string): ChatSession {
  return {
    id,
    title: "Bot chat",
    kind: "direct",
    createdAt: 1000,
    updatedAt: 2000,
    platformBinding: {
      adapterId: "a1",
      conversationKey: ck,
      platform: "telegram",
      conversationRef: { platform: "telegram", adapterId: "a1" },
    },
  } as unknown as ChatSession
}

describe("ConversationPage (/inbox/c?key=)", () => {
  beforeEach(() => {
    mockSession = undefined
    mockKey = "ck1"
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
})
