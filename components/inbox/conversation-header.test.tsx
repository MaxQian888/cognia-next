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
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
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
import { isTauri } from "@/lib/tauri"
import type { TriggerPolicy } from "@/types/connectors/policy"

const EMPTY_POLICY: TriggerPolicy = {
  rules: [],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

beforeEach(() => {
  ;(isTauri as jest.Mock).mockReturnValue(false)
})

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

  it("wraps mode switcher with disabled span in web mode (isTauri=false)", () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    render(
      <ConversationHeader
        conversationKey="ck4"
        sessionId="s4"
        title="Web test"
        platform="telegram"
        currentMode="auto"
        policy={EMPTY_POLICY}
      />
    )
    // In web mode the mode switcher is wrapped in a pointer-events-none disabled span
    const disabled = screen.getByTestId("mode-switcher-disabled")
    expect(disabled).toBeInTheDocument()
    expect(disabled).toHaveAttribute("aria-disabled", "true")
    expect(disabled).toHaveClass("pointer-events-none")
  })

  it("renders mode switcher directly in desktop mode (isTauri=true)", () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    render(
      <ConversationHeader
        conversationKey="ck5"
        sessionId="s5"
        title="Desktop test"
        platform="discord"
        currentMode="manual"
        policy={EMPTY_POLICY}
      />
    )
    // In desktop mode there is no disabled wrapper
    expect(screen.queryByTestId("mode-switcher-disabled")).not.toBeInTheDocument()
    expect(screen.getByTestId("mode-switcher-trigger")).toBeInTheDocument()
  })
})
