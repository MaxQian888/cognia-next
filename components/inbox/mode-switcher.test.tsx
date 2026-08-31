/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks. All factory functions, no variables referenced before declaration.
// ---------------------------------------------------------------------------

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(false),
}))

const mockMutate = jest.fn().mockResolvedValue({ route: "local", conversationKey: "ck" })
// ADR-0131: override writes go through the shell-agnostic facade, which
// picks local-host vs. relay-to-paired-host. The control just describes
// its edit as one mutation.
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: (...a: unknown[]) => mockMutate(...a),
}))

jest.mock("@/components/ui/dropdown-menu")

// ---------------------------------------------------------------------------
// Subject + imported mocks (after mocks are registered)
// ---------------------------------------------------------------------------

import { ModeSwitcher } from "./mode-switcher"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

const mockInvoke = invoke as jest.Mock
const mockIsTauri = isTauri as jest.Mock
const mockUpsert = mockMutate

describe("ModeSwitcher", () => {
  beforeEach(() => {
    mockUpsert.mockReset().mockResolvedValue({ route: "local", conversationKey: "ck1" })
    mockInvoke.mockReset().mockResolvedValue(undefined)
    mockIsTauri.mockReturnValue(false)
  })

  it("renders the current preset label", () => {
    render(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        selection="assistant"
        targetKind="direct"
      />
    )
    // "Assistant" appears in both the trigger badge and the dropdown options.
    expect(screen.getAllByText("Assistant").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId("mode-switcher-trigger")).toHaveAttribute(
      "data-selection",
      "assistant"
    )
  })

  // The whole point of the rewrite: a preset write must carry the AXES, not
  // just the legacy mirror. `objectContaining({ mode })` passed even while the
  // chip was clearing `autonomy` / `engagement` and stranding a delegated
  // conversation, so this asserts the complete mutation.
  it("writes the preset's axes, the legacy mirror and the assignment clear", async () => {
    const onSelectionChange = jest.fn()
    render(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        selection="assistant"
        targetKind="team"
        onSelectionChange={onSelectionChange}
      />
    )

    fireEvent.click(screen.getByTestId("mode-option-delegate"))

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith({
        kind: "upsert",
        input: {
          conversationKey: "ck1",
          sessionId: "s1",
          autonomy: "act",
          engagement: "background",
          mode: "auto",
          routingSource: undefined,
          assignmentPreviousMode: undefined,
          assignmentPreviousAutonomy: undefined,
          assignmentPreviousEngagement: undefined,
          assignmentPreviousRouting: undefined,
          modeForcedBy: undefined,
        },
      })
    })
    expect(onSelectionChange).toHaveBeenCalledWith("delegate")
  })

  // Switching back off `delegate` has to CLEAR the frozen background value, or
  // the conversation keeps running in the background under a preset that says
  // it answers inline. `undefined` here is an explicit clear, and the relay
  // encodes it (see `encodeOverrideMutationClears`).
  it("clears a frozen engagement when leaving delegate", async () => {
    render(
      <ModeSwitcher conversationKey="ck1" sessionId="s1" selection="delegate" targetKind="team" />
    )

    fireEvent.click(screen.getByTestId("mode-option-assistant"))

    await waitFor(() => {
      const input = mockUpsert.mock.calls[0][0].input as Record<string, unknown>
      expect("engagement" in input).toBe(true)
      expect(input.engagement).toBeUndefined()
      expect(input.autonomy).toBe("act")
    })
  })

  it("writes observe + human for silent", async () => {
    render(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        selection="assistant"
        targetKind="direct"
      />
    )

    fireEvent.click(screen.getByTestId("mode-option-silent"))

    await waitFor(() => {
      const input = mockUpsert.mock.calls[0][0].input as Record<string, unknown>
      expect(input.autonomy).toBe("observe")
      expect(input.engagement).toBe("human")
      expect(input.mode).toBe("manual")
    })
  })

  // Background work needs a team or workflow to carry it, so offering
  // `delegate` on a direct-target conversation would offer a value nothing
  // acts on. The menu says why rather than hiding the row.
  it("refuses delegate without a bound target", async () => {
    render(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        selection="assistant"
        targetKind="direct"
      />
    )

    const option = screen.getByTestId("mode-option-delegate")
    expect(option).toBeDisabled()
    expect(screen.getByText("Needs a team or workflow bound first.")).toBeInTheDocument()

    fireEvent.click(option)
    await waitFor(() => expect(mockUpsert).not.toHaveBeenCalled())
  })

  // `custom` is a read-out of axes no preset names, so it opens the advanced
  // editor instead of inventing a second axis editor in the chip.
  it("offers custom only when the stored axes already are custom", () => {
    const { rerender } = render(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        selection="assistant"
        targetKind="direct"
      />
    )
    expect(screen.queryByTestId("mode-option-custom")).toBeNull()

    const onOpenAdvanced = jest.fn()
    rerender(
      <ModeSwitcher
        conversationKey="ck1"
        sessionId="s1"
        selection="custom"
        targetKind="direct"
        onOpenAdvanced={onOpenAdvanced}
      />
    )
    fireEvent.click(screen.getByTestId("mode-option-custom"))
    expect(onOpenAdvanced).toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it("invokes claude_interrupt in Tauri environment on a mode change", async () => {
    mockIsTauri.mockReturnValue(true)

    render(
      <ModeSwitcher
        conversationKey="ck2"
        sessionId="s2"
        selection="assistant"
        targetKind="direct"
      />
    )

    fireEvent.click(screen.getByTestId("mode-option-draft"))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("claude_interrupt", { session_id: "s2" })
    })
  })

  // The override write is routed (ADR-0131) but the interrupt is a Tauri
  // command, so only the second one is desktop-gated.
  it("still writes the override off the desktop, without the interrupt", async () => {
    mockIsTauri.mockReturnValue(false)

    render(
      <ModeSwitcher
        conversationKey="ck3"
        sessionId="s3"
        selection="assistant"
        targetKind="direct"
      />
    )

    fireEvent.click(screen.getByTestId("mode-option-silent"))

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalled()
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
