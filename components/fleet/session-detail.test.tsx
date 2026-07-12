/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { SessionDetail } from "./session-detail"
import type { FleetSession } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ dateTime: () => "TIME" }),
}))

// Reduced motion → count-up is instant, so counts render their target verbatim.
jest.mock("motion/react", () => ({ useReducedMotion: () => true }))

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "claude-code",
    sessionId: "s1",
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
    startedAt: 1000,
    lastEventAt: 2000,
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

describe("SessionDetail", () => {
  it("always renders tool/turn counts and the start time", () => {
    render(<SessionDetail session={session({ toolUseCount: 3, turnCount: 2 })} />)
    expect(screen.getByTestId("detail-tools").textContent).toContain('"count":3')
    expect(screen.getByTestId("detail-turns").textContent).toContain('"count":2')
    expect(screen.getByTestId("detail-started")).toBeInTheDocument()
  })

  it("omits every optional field when absent", () => {
    render(<SessionDetail session={session()} />)
    expect(screen.queryByTestId("detail-cwd")).toBeNull()
    expect(screen.queryByTestId("detail-branch")).toBeNull()
    expect(screen.queryByTestId("detail-session-ref")).toBeNull()
    expect(screen.queryByTestId("detail-source")).toBeNull()
    expect(screen.queryByTestId("detail-pid")).toBeNull()
    expect(screen.queryByTestId("detail-ended")).toBeNull()
    expect(screen.queryByTestId("detail-duration")).toBeNull()
  })

  it("renders each optional field when present", () => {
    render(
      <SessionDetail
        session={session({
          cwd: "/proj",
          gitBranch: "dev",
          terminal: { app: "ghostty", label: "Ghostty", sessionRef: "win-7" },
          startSource: "resume",
          agentPid: 4242,
        })}
      />
    )
    expect(screen.getByTestId("detail-cwd")).toHaveTextContent("/proj")
    expect(screen.getByTestId("detail-branch")).toHaveTextContent("dev")
    expect(screen.getByTestId("detail-session-ref")).toHaveTextContent("win-7")
    expect(screen.getByTestId("detail-source")).toHaveTextContent("source.resume")
    expect(screen.getByTestId("detail-pid").textContent).toContain('"pid":4242')
  })

  it("ignores an unknown start source", () => {
    render(<SessionDetail session={session({ startSource: "weird" })} />)
    expect(screen.queryByTestId("detail-source")).toBeNull()
  })

  it("middle-ellipsizes a long cwd and keeps the full path as a title", () => {
    const cwd = "/Users/someone/very/deeply/nested/path/to/the/project/cognia-next"
    render(<SessionDetail session={session({ cwd })} />)
    const el = screen.getByTestId("detail-cwd")
    expect(el).toHaveAttribute("title", cwd)
    expect(el.textContent).toContain("…")
  })

  it("shows end time and duration only for an ended session", () => {
    const { rerender } = render(
      <SessionDetail session={session({ status: "working", startedAt: 1000, endedAt: 61000 })} />
    )
    // endedAt is present but the status isn't ended → no ended/duration rows.
    expect(screen.queryByTestId("detail-ended")).toBeNull()

    rerender(
      <SessionDetail session={session({ status: "ended", startedAt: 1000, endedAt: 61000 })} />
    )
    expect(screen.getByTestId("detail-ended")).toBeInTheDocument()
    expect(screen.getByTestId("detail-duration").textContent).toContain("1m00s")
  })
})
