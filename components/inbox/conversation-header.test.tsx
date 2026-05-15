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

const mockUseCharacter = jest.fn()
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: (id: string | null | undefined) => mockUseCharacter(id),
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
  mockUseCharacter.mockReturnValue(undefined)
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

  it("renders the live mode switcher chip in desktop mode", () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
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

  it("renders a static disabled badge in web mode (isTauri=false)", () => {
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
    // Web mode renders a static, read-only badge — NOT a live <ModeSwitcher>.
    // The static badge shows the localized mode label and has aria-disabled.
    const disabled = screen.getByTestId("mode-switcher-disabled")
    expect(disabled).toBeInTheDocument()
    expect(disabled).toHaveAttribute("aria-disabled", "true")
    expect(disabled).toHaveTextContent("Auto")
    // The live dropdown trigger must not render — that was the bug we fixed
    // (Radix portals the menu past the pointer-events-none wrapper).
    expect(screen.queryByTestId("mode-switcher-trigger")).not.toBeInTheDocument()
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

  it("renders the character chip when a character is bound", () => {
    mockUseCharacter.mockReturnValue({ id: "c1", name: "Ada" })
    render(
      <ConversationHeader
        conversationKey="ck6"
        sessionId="s6"
        title="Character chat"
        platform="telegram"
        currentMode="auto"
        policy={EMPTY_POLICY}
        characterId="c1"
      />
    )
    expect(screen.getByTestId("conversation-character-chip")).toBeInTheDocument()
    expect(screen.getByText("Ada")).toBeInTheDocument()
  })

  it("omits the character chip when no character is bound", () => {
    mockUseCharacter.mockReturnValue(undefined)
    render(
      <ConversationHeader
        conversationKey="ck7"
        sessionId="s7"
        title="No character"
        platform="discord"
        currentMode="auto"
        policy={EMPTY_POLICY}
      />
    )
    expect(screen.queryByTestId("conversation-character-chip")).not.toBeInTheDocument()
  })
})
