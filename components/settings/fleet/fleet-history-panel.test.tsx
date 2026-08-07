/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { FleetSessionHistoryRow } from "@/lib/db/fleet-sessions"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Reuse the real AgentBadge but stub its translations.
jest.mock("@/components/session-import/session-import-dialog", () => ({
  SessionImportDialog: ({ trigger }: { trigger: React.ReactNode }) => (
    <div data-testid="import-dialog-trigger">{trigger}</div>
  ),
}))

let liveRows: FleetSessionHistoryRow[] | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveRows,
}))

const clearMock = jest.fn()
const clearEndedMock = jest.fn()
const deleteMock = jest.fn()
jest.mock("@/lib/db/fleet-sessions", () => ({
  listFleetHistory: jest.fn(),
  clearFleetHistory: (...args: unknown[]) => clearMock(...args),
  clearEndedFleetHistory: (...args: unknown[]) => clearEndedMock(...args),
  deleteFleetHistory: (...args: unknown[]) => deleteMock(...args),
}))

import { agentsIn, FleetHistoryPanel } from "./fleet-history-panel"

function row(overrides: Partial<FleetSessionHistoryRow> = {}): FleetSessionHistoryRow {
  return {
    id: "claude-code:s1",
    agent: "claude-code",
    sessionId: "s1",
    cwd: "/proj",
    projectName: "proj",
    firstPrompt: "do it",
    terminalLabel: "Ghostty",
    transcriptPath: "/t.jsonl",
    startedAt: Date.now() - 120_000,
    updatedAt: Date.now(),
    endedAt: null,
    outcome: "active",
    ...overrides,
  }
}

beforeEach(() => {
  clearMock.mockReset()
  clearMock.mockResolvedValue(undefined)
  clearEndedMock.mockReset()
  clearEndedMock.mockResolvedValue(0)
  deleteMock.mockReset()
  deleteMock.mockResolvedValue(undefined)
  liveRows = []
})

describe("agentsIn", () => {
  it("returns distinct agents in first-seen order", () => {
    expect(
      agentsIn([row({ agent: "codex" }), row({ agent: "claude-code" }), row({ agent: "codex" })])
    ).toEqual(["codex", "claude-code"])
    expect(agentsIn([])).toEqual([])
  })
})

describe("FleetHistoryPanel", () => {
  it("renders the empty state and disables Clear when there are no rows", () => {
    render(<FleetHistoryPanel />)
    expect(screen.getByTestId("fleet-history-empty")).toBeInTheDocument()
    expect(screen.getByTestId("fleet-history-clear")).toBeDisabled()
    expect(screen.getByTestId("fleet-history-clear-ended")).toBeDisabled()
    expect(screen.getByTestId("import-dialog-trigger")).toBeInTheDocument()
  })

  it("renders rows with agent, project, terminal, outcome and prompt preview", () => {
    liveRows = [
      row(),
      row({
        id: "codex:s2",
        agent: "codex",
        sessionId: "s2",
        projectName: "api",
        outcome: "ended",
        endedAt: Date.now() - 60_000,
        terminalLabel: null,
      }),
    ]
    render(<FleetHistoryPanel />)
    expect(screen.getByText("proj")).toBeInTheDocument()
    expect(screen.getByText("api")).toBeInTheDocument()
    expect(screen.getByText("Ghostty")).toBeInTheDocument()
    // Active vs ended labels.
    expect(screen.getByTestId("fleet-history-outcome-claude-code:s1").textContent).toContain(
      "activeFor"
    )
    expect(screen.getByTestId("fleet-history-outcome-codex:s2").textContent).toContain("endedAgo")
    // Ended rows show their run duration; active rows don't.
    expect(screen.getByTestId("fleet-history-duration-codex:s2").textContent).toContain("ranFor")
    expect(screen.queryByTestId("fleet-history-duration-claude-code:s1")).toBeNull()
    // First prompt preview.
    expect(screen.getByTestId("fleet-history-prompt-claude-code:s1").textContent).toBe("do it")
    // Count badge.
    expect(screen.getByTestId("fleet-history-count").textContent).toBe("2")
  })

  it("renders detached sessions without claiming they ended or remain active", () => {
    liveRows = [row({ id: "opencode:s3", agent: "opencode", sessionId: "s3", outcome: "detached" })]
    render(<FleetHistoryPanel />)
    expect(screen.getByTestId("fleet-history-outcome-opencode:s3").textContent).toContain(
      "detachedAgo"
    )
    expect(screen.queryByTestId("fleet-history-duration-opencode:s3")).toBeNull()
  })

  it("falls back to the session id when there's no project name", () => {
    liveRows = [row({ projectName: null })]
    render(<FleetHistoryPanel />)
    expect(screen.getByText("s1")).toBeInTheDocument()
  })

  it("clears history on click", async () => {
    liveRows = [row()]
    render(<FleetHistoryPanel />)
    fireEvent.click(screen.getByTestId("fleet-history-clear"))
    await waitFor(() => expect(clearMock).toHaveBeenCalled())
  })

  it("clears only ended rows via Clear ended", async () => {
    liveRows = [row(), row({ id: "codex:s2", sessionId: "s2", outcome: "ended", endedAt: 1 })]
    render(<FleetHistoryPanel />)
    const button = screen.getByTestId("fleet-history-clear-ended")
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(clearEndedMock).toHaveBeenCalled())
    expect(clearMock).not.toHaveBeenCalled()
  })

  it("ignores a re-entrant clear while one is in flight", async () => {
    let resolveClear: () => void = () => {}
    clearMock.mockReturnValue(new Promise<void>((r) => (resolveClear = r)))
    liveRows = [row()]
    render(<FleetHistoryPanel />)
    const button = screen.getByTestId("fleet-history-clear")
    fireEvent.click(button)
    // Second click while the first is pending must be a no-op (busy guard).
    fireEvent.click(button)
    resolveClear()
    await waitFor(() => expect(clearMock).toHaveBeenCalledTimes(1))
  })

  it("deletes a single row via its inline button", async () => {
    liveRows = [row()]
    render(<FleetHistoryPanel />)
    fireEvent.click(screen.getByTestId("fleet-history-delete-claude-code:s1"))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("claude-code:s1"))
  })

  it("shows agent filter chips only when more than one agent is present", () => {
    liveRows = [row(), row({ id: "claude-code:s2", sessionId: "s2" })]
    const { rerender } = render(<FleetHistoryPanel />)
    expect(screen.queryByTestId("fleet-history-filters")).toBeNull()

    liveRows = [row(), row({ id: "codex:s2", agent: "codex", sessionId: "s2" })]
    rerender(<FleetHistoryPanel />)
    expect(screen.getByTestId("fleet-history-filters")).toBeInTheDocument()
  })

  it("filters rows by agent and resets via All", () => {
    liveRows = [row(), row({ id: "codex:s2", agent: "codex", sessionId: "s2", projectName: "api" })]
    render(<FleetHistoryPanel />)
    fireEvent.click(screen.getByTestId("fleet-history-filter-codex"))
    expect(screen.queryByTestId("fleet-history-row-claude-code:s1")).toBeNull()
    expect(screen.getByTestId("fleet-history-row-codex:s2")).toBeInTheDocument()
    expect(screen.getByTestId("fleet-history-filter-codex")).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByTestId("fleet-history-filter-all"))
    expect(screen.getByTestId("fleet-history-row-claude-code:s1")).toBeInTheDocument()
  })

  it("collapses long histories behind a show-all toggle", () => {
    liveRows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `claude-code:s${i}`, sessionId: `s${i}` })
    )
    render(<FleetHistoryPanel />)
    expect(screen.getAllByTestId(/^fleet-history-row-/)).toHaveLength(8)
    const toggle = screen.getByTestId("fleet-history-toggle-expand")
    expect(toggle.textContent).toContain("showMore")
    fireEvent.click(toggle)
    expect(screen.getAllByTestId(/^fleet-history-row-/)).toHaveLength(12)
    expect(screen.getByTestId("fleet-history-toggle-expand").textContent).toContain("showLess")
    fireEvent.click(screen.getByTestId("fleet-history-toggle-expand"))
    expect(screen.getAllByTestId(/^fleet-history-row-/)).toHaveLength(8)
  })

  it("falls back to startedAt for an ended row missing endedAt", () => {
    liveRows = [row({ outcome: "ended", endedAt: null, startedAt: Date.now() - 90_000 })]
    render(<FleetHistoryPanel />)
    expect(screen.getByTestId("fleet-history-outcome-claude-code:s1").textContent).toContain(
      "endedAgo"
    )
    // No duration without a real endedAt.
    expect(screen.queryByTestId("fleet-history-duration-claude-code:s1")).toBeNull()
  })

  it("renders nothing for the list while the query is loading (undefined)", () => {
    liveRows = undefined
    render(<FleetHistoryPanel />)
    expect(screen.queryByTestId("fleet-history-list")).toBeNull()
    expect(screen.queryByTestId("fleet-history-empty")).toBeNull()
  })
})
