/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockBack = jest.fn()
const mockPush = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: mockBack }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox",
  redirect: jest.fn(),
}))

jest.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({
    className,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    className?: string
    "data-testid"?: string
    "aria-label"?: string
  }) => <button type="button" data-testid={testId} aria-label={ariaLabel} className={className} />,
}))

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: jest.fn().mockResolvedValue({}),
}))

jest.mock("@/components/ui/dropdown-menu")

jest.mock("@/components/ui/tooltip")

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
  mockBack.mockReset()
  mockPush.mockReset()
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

  it("renders the mobile back button and the mobile sidebar trigger", () => {
    render(
      <ConversationHeader
        conversationKey="ck8"
        sessionId="s8"
        title="Mobile chrome"
        platform="telegram"
        currentMode="auto"
        policy={EMPTY_POLICY}
      />
    )
    const back = screen.getByTestId("conversation-header-back")
    const trigger = screen.getByTestId("conversation-header-open-sidebar")
    expect(back).toBeInTheDocument()
    expect(trigger).toBeInTheDocument()
    expect(back).toHaveClass("md:hidden")
    expect(trigger).toHaveClass("md:hidden")
    expect(back).toHaveAccessibleName(/back to list/i)
    expect(trigger).toHaveAccessibleName(/open adapters/i)
  })

  it("back button calls router.back() when history has more than one entry", () => {
    // jsdom defaults to history.length === 1 — push an extra state so back()
    // is the chosen branch.
    window.history.pushState({}, "", "/inbox/c/ck-prev")
    expect(window.history.length).toBeGreaterThan(1)

    render(
      <ConversationHeader
        conversationKey="ck9"
        sessionId="s9"
        title="Back test"
        platform="telegram"
        currentMode="auto"
        policy={EMPTY_POLICY}
      />
    )

    fireEvent.click(screen.getByTestId("conversation-header-back"))
    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("back button falls back to router.push('/inbox') when no history is available", () => {
    // Spy on history.length to force the fallback branch — directly setting
    // window.history.length isn't reliable across jsdom versions.
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)

    render(
      <ConversationHeader
        conversationKey="ck10"
        sessionId="s10"
        title="Deep-link test"
        platform="telegram"
        currentMode="auto"
        policy={EMPTY_POLICY}
      />
    )

    fireEvent.click(screen.getByTestId("conversation-header-back"))
    expect(mockPush).toHaveBeenCalledWith("/inbox")
    expect(mockBack).not.toHaveBeenCalled()

    lengthSpy.mockRestore()
  })
})
