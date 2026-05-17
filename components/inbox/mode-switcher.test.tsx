/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks — all factory functions; no variables referenced before declaration.
// ---------------------------------------------------------------------------

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(false),
}))

jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: jest.fn().mockResolvedValue({}),
}))

jest.mock("@/components/ui/dropdown-menu")

// ---------------------------------------------------------------------------
// Subject + imported mocks (after mocks are registered)
// ---------------------------------------------------------------------------

import { ModeSwitcher } from "./mode-switcher"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"

const mockInvoke = invoke as jest.Mock
const mockIsTauri = isTauri as jest.Mock
const mockUpsert = upsertByConversationKey as jest.Mock

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModeSwitcher", () => {
  beforeEach(() => {
    mockUpsert.mockReset().mockResolvedValue({})
    mockInvoke.mockReset().mockResolvedValue(undefined)
    mockIsTauri.mockReturnValue(false)
  })

  it("renders the current mode label", () => {
    render(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        currentMode="auto"
        onModeChange={jest.fn()}
      />
    )
    // "Auto" appears in both the trigger badge and the dropdown options
    expect(screen.getAllByText("Auto").length).toBeGreaterThanOrEqual(1)
  })

  it("clicking a mode option writes the override row", async () => {
    const onModeChange = jest.fn()
    render(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        currentMode="auto"
        onModeChange={onModeChange}
      />
    )

    fireEvent.click(screen.getByTestId("mode-option-manual"))

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ conversationKey: "ck1", sessionId: "s1", mode: "manual" })
      )
    })
    expect(onModeChange).toHaveBeenCalledWith("manual")
  })

  it("invokes claude_interrupt in Tauri environment on mode change", async () => {
    mockIsTauri.mockReturnValue(true)

    render(
      <ModeSwitcher
        conversationKey="ck2"
        sessionId="s2"
        currentMode="auto"
        onModeChange={jest.fn()}
      />
    )

    fireEvent.click(screen.getByTestId("mode-option-draft"))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("claude_interrupt", { session_id: "s2" })
    })
  })

  it("does not invoke claude_interrupt in web mode", async () => {
    mockIsTauri.mockReturnValue(false)

    render(<ModeSwitcher conversationKey="ck3" sessionId="s3" currentMode="auto" />)

    fireEvent.click(screen.getByTestId("mode-option-manual"))

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalled()
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
