/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { IslandRow } from "./island-row"
import type { FleetSession } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ dateTime: () => "TIME" }),
}))

// The expanded detail panel reads OS reduced-motion; pin it so counts are instant.
jest.mock("motion/react", () => ({ useReducedMotion: () => true }))

const focusMock = jest.fn()
const sendMock = jest.fn()
const revealMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  fleetPermissionRespond: jest.fn(),
  fleetFocusTerminal: (...args: unknown[]) => focusMock(...args),
  fleetOpencodeSendMessage: (...args: unknown[]) => sendMock(...args),
  fleetRevealTranscript: (...args: unknown[]) => revealMock(...args),
}))

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
    status: "working",
    cwd: "/Users/x/proj/cognia-next",
    projectName: "cognia-next",
    lastPrompt: "fix the login bug",
    activity: { toolName: "Bash", detail: "pnpm test" },
    permissionMode: "default",
    model: null,
    terminal: { app: "ghostty", label: "Ghostty" },
    transcriptPath: null,
    agentPid: 123,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: true,
      openTranscript: true,
    },
    startedAt: Date.now() - 134_000, // 2m14s ago
    lastEventAt: Date.now(),
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  focusMock.mockClear()
  revealMock.mockClear()
})

describe("IslandRow", () => {
  it("focuses the terminal on row click when capable", () => {
    render(<IslandRow session={session()} />)
    const row = screen.getByTestId("island-row-claude-code-s1")
    expect(row.getAttribute("role")).toBe("button")
    fireEvent.click(row)
    expect(focusMock).toHaveBeenCalledWith("claude-code", "s1")
  })

  it("focuses the terminal via Enter and Space keys", () => {
    render(<IslandRow session={session()} />)
    const row = screen.getByTestId("island-row-claude-code-s1")
    fireEvent.keyDown(row, { key: "Enter" })
    expect(focusMock).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(row, { key: " " })
    expect(focusMock).toHaveBeenCalledTimes(2)
    // Other keys do nothing.
    fireEvent.keyDown(row, { key: "a" })
    expect(focusMock).toHaveBeenCalledTimes(2)
  })

  it("is not a button and never focuses when the terminal is unknown", () => {
    render(
      <IslandRow
        session={session({
          terminal: null,
          capabilities: {
            approvePermission: false,
            sendMessage: false,
            focusTerminal: false,
            openTranscript: false,
          },
        })}
      />
    )
    const row = screen.getByTestId("island-row-claude-code-s1")
    expect(row.getAttribute("role")).toBeNull()
    fireEvent.click(row)
    expect(focusMock).not.toHaveBeenCalled()
  })

  it("does not focus the terminal when clicking the permission buttons", () => {
    render(
      <IslandRow
        session={session({
          status: "waiting-permission",
          pendingPermission: {
            requestId: "r1",
            toolName: "Bash",
            detail: null,
            requestedAt: Date.now(),
          },
        })}
      />
    )
    fireEvent.click(screen.getByTestId("permission-deny"))
    // Keyboard on the controls must not bubble to the row's focus handler.
    fireEvent.keyDown(screen.getByTestId("permission-deny"), { key: "Enter" })
    expect(focusMock).not.toHaveBeenCalled()
  })

  it("renders project, agent badge, terminal badge, prompt and activity", () => {
    render(<IslandRow session={session()} />)
    expect(screen.getByText("cognia-next")).toBeInTheDocument()
    expect(screen.getByTestId("agent-badge-claude-code")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-badge")).toHaveTextContent("Ghostty")
    expect(screen.getByTestId("last-prompt")).toHaveTextContent("fix the login bug")
    expect(screen.getByTestId("status-line")).toHaveTextContent("Bash(pnpm test)")
    expect(screen.getByTestId("elapsed").textContent).toMatch(/^2m1[45]s$/)
  })

  it("falls back to the session id and hides optional chrome", () => {
    render(
      <IslandRow
        session={session({
          projectName: null,
          terminal: null,
          lastPrompt: null,
          activity: null,
          status: "idle",
        })}
      />
    )
    expect(screen.getByText("s1")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-badge")).toBeNull()
    expect(screen.queryByTestId("last-prompt")).toBeNull()
    expect(screen.getByTestId("status-line")).toHaveTextContent("status.idle")
  })

  it("shows waiting/plan/ended status lines", () => {
    for (const [status, key] of [
      ["waiting-input", "status.waitingInput"],
      ["plan-pending", "status.planPending"],
      ["ended", "status.ended"],
    ] as const) {
      const { unmount } = render(<IslandRow session={session({ status, activity: null })} />)
      expect(screen.getByTestId("status-line")).toHaveTextContent(key)
      unmount()
    }
  })

  it("renders permission actions instead of the status line when pending", () => {
    render(
      <IslandRow
        session={session({
          status: "waiting-permission",
          pendingPermission: {
            requestId: "r1",
            toolName: "Bash",
            detail: "rm -rf build",
            requestedAt: Date.now(),
          },
        })}
      />
    )
    expect(screen.getByTestId("island-permission-actions")).toBeInTheDocument()
    expect(screen.queryByTestId("status-line")).toBeNull()
  })

  it("shows a plain hint for waiting-permission without an approvable request", () => {
    render(<IslandRow session={session({ status: "waiting-permission" })} />)
    expect(screen.getByTestId("status-line")).toHaveTextContent("status.waitingPermission")
  })

  it("renders a parked question with header, options and more-count instead of the status line", () => {
    render(
      <IslandRow
        session={session({
          status: "waiting-input",
          activity: null,
          pendingQuestions: [
            {
              question: "Which auth method should we use?",
              header: "Auth",
              options: ["OAuth", "API key"],
              multiSelect: false,
            },
            { question: "Enable telemetry?", options: ["Yes", "No"], multiSelect: true },
          ],
        })}
      />
    )
    const block = screen.getByTestId("pending-question")
    expect(block).toHaveTextContent("Auth")
    expect(block).toHaveTextContent("Which auth method should we use?")
    expect(screen.getByTestId("question-options")).toHaveTextContent("OAuth")
    expect(screen.getByTestId("question-options")).toHaveTextContent("API key")
    expect(screen.getByTestId("question-more").textContent).toContain("questionMore")
    // The generic waiting-input status line is superseded by the question.
    expect(screen.queryByTestId("status-line")).toBeNull()
  })

  it("keeps the generic waiting-input line when no question is parked", () => {
    render(<IslandRow session={session({ status: "waiting-input", activity: null })} />)
    expect(screen.getByTestId("status-line")).toHaveTextContent("status.waitingInput")
    expect(screen.queryByTestId("pending-question")).toBeNull()
  })

  it("shows the plan preview while plan-pending", () => {
    render(
      <IslandRow
        session={session({
          status: "plan-pending",
          activity: null,
          pendingPlan: "## Steps\n1. Do X\n2. Do Y",
        })}
      />
    )
    expect(screen.getByTestId("pending-plan")).toHaveTextContent("1. Do X")
    // Status line still explains where to approve.
    expect(screen.getByTestId("status-line")).toHaveTextContent("status.planPending")
  })

  it("hides the plan preview outside plan-pending", () => {
    render(<IslandRow session={session({ status: "working", pendingPlan: "text" })} />)
    expect(screen.queryByTestId("pending-plan")).toBeNull()
  })

  it("lists subagents with background markers and an overflow chip", () => {
    render(
      <IslandRow
        session={session({
          subagents: [
            { description: "Audit i18n", agentType: "Explore", background: false, startedAt: 1 },
            { description: "Watch tests", agentType: null, background: true, startedAt: 2 },
            { description: "third", background: false, startedAt: 3 },
            { description: "fourth", background: false, startedAt: 4 },
          ],
        })}
      />
    )
    const block = screen.getByTestId("subagents")
    expect(block).toHaveTextContent("subagents")
    expect(screen.getByTestId("subagent-chip-0")).toHaveTextContent("Explore · Audit i18n")
    expect(screen.getByTestId("subagent-chip-0")).toHaveAttribute("data-background", "false")
    expect(screen.getByTestId("subagent-chip-1")).toHaveAttribute("data-background", "true")
    expect(screen.getByTestId("subagent-chip-1")).toHaveTextContent("subagentBackground")
    // Only 3 chips render; the fourth folds into the overflow counter.
    expect(screen.queryByTestId("subagent-chip-3")).toBeNull()
    expect(screen.getByTestId("subagent-overflow")).toHaveTextContent("+1")
  })

  it("renders no subagent block for sessions without subagents", () => {
    render(<IslandRow session={session()} />)
    expect(screen.queryByTestId("subagents")).toBeNull()
  })

  it("applies the staggered entrance delay with backwards fill", () => {
    render(<IslandRow session={session()} enterDelayMs={90} />)
    const row = screen.getByTestId("island-row-claude-code-s1")
    expect(row.style.animationDelay).toBe("90ms")
    expect(row.style.animationFillMode).toBe("backwards")
  })

  it("omits animation inline styles without a stagger delay", () => {
    render(<IslandRow session={session()} />)
    const row = screen.getByTestId("island-row-claude-code-s1")
    expect(row.style.animationDelay).toBe("")
  })

  it("shows a reply affordance for OpenCode sessions that accept messages", () => {
    render(
      <IslandRow
        session={session({
          agent: "opencode",
          capabilities: {
            approvePermission: false,
            sendMessage: true,
            focusTerminal: false,
            openTranscript: false,
          },
        })}
      />
    )
    expect(screen.getByTestId("island-reply-open")).toBeInTheDocument()
  })

  it("hides the reply affordance once the session ended", () => {
    render(
      <IslandRow
        session={session({
          agent: "opencode",
          status: "ended",
          capabilities: {
            approvePermission: false,
            sendMessage: true,
            focusTerminal: false,
            openTranscript: false,
          },
        })}
      />
    )
    expect(screen.queryByTestId("island-reply-open")).toBeNull()
  })

  it("reveals the transcript without focusing the terminal, only when a path is known", () => {
    // Capability present but no path yet → no button.
    const { rerender } = render(<IslandRow session={session({ transcriptPath: null })} />)
    expect(screen.queryByTestId("island-reveal-transcript")).toBeNull()

    rerender(<IslandRow session={session({ transcriptPath: "/x/proj/abc.jsonl" })} />)
    const button = screen.getByTestId("island-reveal-transcript")
    fireEvent.click(button)
    expect(revealMock).toHaveBeenCalledWith("/x/proj/abc.jsonl")
    // The click must not bubble to the row's focus-terminal handler.
    expect(focusMock).not.toHaveBeenCalled()
  })

  it("hides the reveal action when the capability is off", () => {
    render(
      <IslandRow
        session={session({
          transcriptPath: "/x/proj/abc.jsonl",
          capabilities: {
            approvePermission: false,
            sendMessage: false,
            focusTerminal: true,
            openTranscript: false,
          },
        })}
      />
    )
    expect(screen.queryByTestId("island-reveal-transcript")).toBeNull()
  })

  it("renders model and permission-mode meta chips only when noteworthy", () => {
    const { rerender } = render(<IslandRow session={session()} />)
    // Default mode + no model → no meta chips.
    expect(screen.queryByTestId("session-meta-chips")).toBeNull()

    rerender(
      <IslandRow
        session={session({ model: "claude-opus-4-8", permissionMode: "bypassPermissions" })}
      />
    )
    expect(screen.getByTestId("session-model-chip")).toHaveTextContent("Opus")
    const modeChip = screen.getByTestId("session-mode-chip")
    expect(modeChip).toHaveAttribute("data-mode", "bypassPermissions")
    expect(modeChip).toHaveAttribute("data-risk", "danger")
  })

  it("appends how long a blocked session has been waiting", () => {
    render(
      <IslandRow
        session={session({
          status: "waiting-input",
          activity: null,
          lastEventAt: Date.now() - 65_000, // 1m05s ago
        })}
      />
    )
    const waited = screen.getByTestId("status-waited")
    expect(waited.textContent).toContain("waitingFor")
    expect(waited.textContent).toMatch(/1m0[45]s/)
  })

  it("shows the waited duration inside a parked question block", () => {
    render(
      <IslandRow
        session={session({
          status: "waiting-input",
          activity: null,
          lastEventAt: Date.now() - 30_000,
          pendingQuestions: [{ question: "Proceed?", options: ["Yes"], multiSelect: false }],
        })}
      />
    )
    expect(screen.getByTestId("question-waited").textContent).toContain("waitingFor")
  })

  it("paints an error banner (and dot accent) when the session has a last error", () => {
    const { rerender } = render(<IslandRow session={session()} />)
    expect(screen.queryByTestId("row-error")).toBeNull()

    rerender(
      <IslandRow
        session={session({ lastError: { kind: "turn", detail: "API overloaded", at: 0 } })}
      />
    )
    const banner = screen.getByTestId("row-error")
    expect(screen.getByTestId("row-error-kind")).toHaveTextContent("error.turn")
    expect(banner.textContent).toContain("API overloaded")
  })

  it("freezes an ended row's runtime at its end time", () => {
    render(<IslandRow session={session({ status: "ended", startedAt: 1_000, endedAt: 61_000 })} />)
    // 60s between start and end — does not tick past that regardless of `now`.
    expect(screen.getByTestId("elapsed")).toHaveTextContent("1m00s")
  })

  it("flags a multi-select question", () => {
    const { rerender } = render(
      <IslandRow
        session={session({
          status: "waiting-input",
          activity: null,
          pendingQuestions: [{ question: "Pick", options: ["a"], multiSelect: false }],
        })}
      />
    )
    expect(screen.queryByTestId("question-multiselect")).toBeNull()

    rerender(
      <IslandRow
        session={session({
          status: "waiting-input",
          activity: null,
          pendingQuestions: [{ question: "Pick", options: ["a", "b"], multiSelect: true }],
        })}
      />
    )
    expect(screen.getByTestId("question-multiselect")).toBeInTheDocument()
  })

  it("shows a per-subagent elapsed label", () => {
    render(
      <IslandRow
        session={session({
          subagents: [
            { description: "explore repo", background: false, startedAt: Date.now() - 5_000 },
          ],
        })}
      />
    )
    expect(screen.getByTestId("subagent-elapsed-0").textContent).toMatch(/\ds/)
  })

  it("toggles the detail panel without also focusing the terminal", () => {
    const onToggle = jest.fn()
    render(<IslandRow session={session()} detailExpanded={false} onToggleDetail={onToggle} />)
    // Detail hidden until the parent flips the flag.
    expect(screen.queryByTestId("session-detail")).toBeNull()
    fireEvent.click(screen.getByTestId("session-detail-toggle"))
    expect(onToggle).toHaveBeenCalledTimes(1)
    // The row is a focus-terminal button, but the toggle stops propagation.
    expect(focusMock).not.toHaveBeenCalled()
  })

  it("renders the detail panel when expanded and hides the toggle without a handler", () => {
    const { rerender } = render(<IslandRow session={session()} />)
    // No handler → no chevron affordance.
    expect(screen.queryByTestId("session-detail-toggle")).toBeNull()

    rerender(<IslandRow session={session()} detailExpanded onToggleDetail={jest.fn()} />)
    expect(screen.getByTestId("session-detail")).toBeInTheDocument()
  })

  it("flashes once when the row newly needs the user, then clears on animation end", () => {
    const { rerender } = render(<IslandRow session={session({ status: "working" })} />)
    expect(screen.queryByTestId("row-flash")).toBeNull()

    rerender(<IslandRow session={session({ status: "waiting-permission" })} />)
    const flash = screen.getByTestId("row-flash")
    fireEvent.animationEnd(flash)
    expect(screen.queryByTestId("row-flash")).toBeNull()
  })

  it("does not flash on mount, nor when moving between two attention states", () => {
    const { rerender } = render(<IslandRow session={session({ status: "plan-pending" })} />)
    // Mounting straight into an attention state has no prior status to flash from.
    expect(screen.queryByTestId("row-flash")).toBeNull()
    rerender(<IslandRow session={session({ status: "waiting-permission" })} />)
    expect(screen.queryByTestId("row-flash")).toBeNull()
  })
})
