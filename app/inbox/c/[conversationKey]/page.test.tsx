/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import React from "react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox/c/ck1",
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

jest.mock("@/components/inbox/draft-banner", () => ({
  DraftBanner: () => <div data-testid="draft-banner-stub" />,
}))

// React.use — mock to unwrap the params promise synchronously.
let mockParamsValue = { conversationKey: "ck1" }

jest.mock("react", () => {
  const actual = jest.requireActual<typeof React>("react")
  return {
    ...actual,
    use: (p: unknown) => {
      if (p && typeof (p as { then?: unknown }).then === "function") {
        return mockParamsValue
      }
      return actual.use(p as Parameters<typeof actual.use>[0])
    },
  }
})

import type { ChatSession } from "@/lib/claude/types"

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

describe("ConversationPage (/inbox/c/[conversationKey])", () => {
  beforeEach(() => {
    mockSession = undefined
    mockParamsValue = { conversationKey: "ck1" }
  })

  it("renders InboxShell in loading state when session is undefined", () => {
    mockSession = undefined
    render(<ConversationPage params={Promise.resolve({ conversationKey: "ck1" })} />)
    expect(screen.getByTestId("inbox-shell")).toBeInTheDocument()
    expect(screen.getByText("Loading…")).toBeInTheDocument()
  })

  it("renders conversation header when session found", () => {
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage params={Promise.resolve({ conversationKey: "ck1" })} />)
    expect(screen.getByTestId("conversation-header")).toBeInTheDocument()
    expect(screen.getByText("Bot chat")).toBeInTheDocument()
  })

  it("renders conversation detail pane when session found", () => {
    mockSession = makeSession("s1", "ck1")
    render(<ConversationPage params={Promise.resolve({ conversationKey: "ck1" })} />)
    expect(screen.getByTestId("conversation-detail")).toBeInTheDocument()
  })
})
