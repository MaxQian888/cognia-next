/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox",
  redirect: jest.fn(),
}))

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: jest.fn().mockResolvedValue({}),
}))

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { ConversationHeader } from "./conversation-header"
import type { TriggerPolicy } from "@/types/connectors/policy"

const EMPTY_POLICY: TriggerPolicy = {
  rules: [],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

describe("ConversationHeader", () => {
  it("renders the conversation title", () => {
    render(
      <ConversationHeader
        conversationKey="ck1"
        sessionId="s1"
        title="My Telegram Chat"
        platform="telegram"
        currentMode="auto"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByText("My Telegram Chat")).toBeInTheDocument()
  })

  it("renders the mode switcher chip", () => {
    render(
      <ConversationHeader
        conversationKey="ck2"
        sessionId="s2"
        title="Test"
        platform="discord"
        currentMode="manual"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByTestId("mode-switcher-trigger")).toBeInTheDocument()
    expect(screen.getAllByText("Manual").length).toBeGreaterThanOrEqual(1)
  })

  it("renders the policy info chip", () => {
    render(
      <ConversationHeader
        conversationKey="ck3"
        sessionId="s3"
        title="Test"
        platform="slack"
        currentMode="auto"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.getByTestId("policy-info-trigger")).toBeInTheDocument()
  })
})
