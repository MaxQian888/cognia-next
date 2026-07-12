/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { SessionMetaChips } from "./session-meta-chips"
import type { FleetSession } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}(${JSON.stringify(vals)})` : `${ns}.${key}`,
}))

function session(overrides: Partial<FleetSession>): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s",
    status: "working",
    cwd: null,
    projectName: null,
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
    },
    startedAt: 0,
    lastEventAt: 0,
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

describe("SessionMetaChips", () => {
  it("renders the short model brand label", () => {
    render(<SessionMetaChips session={session({ model: "claude-opus-4-8" })} />)
    const chip = screen.getByTestId("session-model-chip")
    expect(chip).toHaveTextContent("Opus")
    expect(chip.getAttribute("aria-label")).toContain("Opus")
  })

  it("flags a bypassPermissions session as a danger chip with a warning marker", () => {
    render(
      <SessionMetaChips session={session({ permissionMode: "bypassPermissions", model: null })} />
    )
    const chip = screen.getByTestId("session-mode-chip")
    expect(chip.getAttribute("data-mode")).toBe("bypassPermissions")
    expect(chip.getAttribute("data-risk")).toBe("danger")
    expect(chip).toHaveTextContent("⚠")
    // Label reuses the shared chat.permissionMode copy (i18nKey "bypass").
    expect(chip).toHaveTextContent("chat.permissionMode.bypass.label")
  })

  it("renders plan/acceptEdits modes without a warning marker", () => {
    const { rerender } = render(<SessionMetaChips session={session({ permissionMode: "plan" })} />)
    let chip = screen.getByTestId("session-mode-chip")
    expect(chip.getAttribute("data-risk")).toBe("safe")
    expect(chip).not.toHaveTextContent("⚠")

    rerender(<SessionMetaChips session={session({ permissionMode: "acceptEdits" })} />)
    chip = screen.getByTestId("session-mode-chip")
    expect(chip.getAttribute("data-risk")).toBe("elevated")
    expect(chip).not.toHaveTextContent("⚠")
  })

  it("hides the mode chip for the default and unknown modes", () => {
    const { rerender } = render(
      <SessionMetaChips session={session({ permissionMode: "default" })} />
    )
    expect(screen.queryByTestId("session-mode-chip")).toBeNull()

    rerender(<SessionMetaChips session={session({ permissionMode: "totally-made-up" })} />)
    expect(screen.queryByTestId("session-mode-chip")).toBeNull()
  })

  it("renders both chips together and nothing when neither applies", () => {
    const { rerender } = render(
      <SessionMetaChips
        session={session({ model: "claude-sonnet-4-6", permissionMode: "acceptEdits" })}
      />
    )
    expect(screen.getByTestId("session-model-chip")).toHaveTextContent("Sonnet")
    expect(screen.getByTestId("session-mode-chip")).toBeInTheDocument()

    rerender(<SessionMetaChips session={session({ model: null, permissionMode: null })} />)
    expect(screen.queryByTestId("session-meta-chips")).toBeNull()
  })
})
