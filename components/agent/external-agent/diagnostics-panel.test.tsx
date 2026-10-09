/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import en from "@/i18n/messages/en.json"
import type {
  ExternalAgentConfig,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"
import { ExternalAgentDiagnosticsPanel } from "./diagnostics-panel"

jest.mock("./capability-matrix", () => ({
  ExternalAgentCapabilityMatrix: () => <div data-testid="capability-matrix" />,
}))

const diag = en.externalAgent.manager.diagnostics

const config = {
  id: "agent-1",
  name: "Codex",
  protocol: "acp",
  transport: "stdio",
} as unknown as ExternalAgentConfig

const activity = { richContentBlocks: 2, compactionUpdates: 1, nesSuggestions: 0 }

/** The value cell next to a label, so a row cannot pass on another row's text. */
const valueOf = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement

describe("ExternalAgentDiagnosticsPanel", () => {
  it("renders a sparse agent with defaults, not raw keys", () => {
    render(
      <ExternalAgentDiagnosticsPanel
        config={config}
        executable
        blockedReason={null}
        activity={activity}
      />
    )
    expect(valueOf(diag.field.executable)).toHaveTextContent(diag.yes)
    expect(valueOf(diag.field.health)).toHaveTextContent(diag.unknown)
    expect(valueOf(diag.field.lifecycleStage)).toHaveTextContent("config")
    expect(valueOf(diag.field.protocol)).toHaveTextContent("ACP via stdio")
    expect(valueOf(diag.field.authMethods)).toHaveTextContent(diag.none)
    expect(valueOf(diag.field.acpActivity)).toHaveTextContent(
      "2 content blocks · 1 compactions · 0 edit suggestions"
    )
    expect(valueOf(diag.field.sessionSupport)).toHaveTextContent(
      `${diag.sessionMethod.list} · ${diag.supportState.unknown}`
    )
    // Nothing to act on, so no callout; no latest run, so no section.
    expect(screen.queryByRole("note")).not.toBeInTheDocument()
    expect(screen.queryByText(diag.sectionLatestRun)).not.toBeInTheDocument()
    expect(screen.getByTestId("capability-matrix")).toBeInTheDocument()
    expect(screen.queryByText(/externalAgent\.manager\.diagnostics\./)).not.toBeInTheDocument()
  })

  it("leads with what blocks the agent and what to do about it", () => {
    const validity = {
      executable: false,
      blockingReasonCode: "transport_blocked",
      healthStatus: "unhealthy",
      sessionExtensions: {
        "session/list": { state: "supported" },
        "session/fork": { state: "unsupported" },
      },
      recoveryHints: [],
    } as unknown as ExternalAgentValiditySnapshot
    render(
      <ExternalAgentDiagnosticsPanel
        config={config}
        validity={validity}
        executable={false}
        blockedReason="Install the desktop app"
        ecosystem={{ recommendedActions: ["Run the installer"] }}
        activity={activity}
      />
    )
    // The value says yes/no; the reason code under it goes through the shared
    // vocabulary rather than printing a snake_case identifier.
    expect(valueOf(diag.field.executable)).toHaveTextContent(diag.no)
    expect(valueOf(diag.field.executable)).toHaveClass("text-amber-600")
    expect(valueOf(diag.field.executable).nextElementSibling).toHaveTextContent(
      en.diagnostics.code.transportBlocked.label
    )
    expect(screen.queryByText(/transport_blocked/)).not.toBeInTheDocument()
    expect(valueOf(diag.field.health)).toHaveTextContent("unhealthy")
    const note = screen.getByRole("note")
    expect(note).toHaveTextContent(diag.sectionNextSteps)
    expect(note).toHaveTextContent("Install the desktop app")
    expect(note).toHaveTextContent("Run the installer")
    expect(valueOf(diag.field.sessionSupport)).toHaveTextContent(
      `${diag.sessionMethod.fork} · ${diag.supportState.unsupported}`
    )
  })

  it("shows the latest run with its trace and session ids", () => {
    render(
      <ExternalAgentDiagnosticsPanel
        config={config}
        executable
        blockedReason={null}
        activity={activity}
        lastRun={{
          terminalOutcome: "error",
          branchReasonCode: "ok",
          branchOutcome: "external",
          timestamp: new Date("2026-10-01T10:00:00Z"),
          linkedTraceId: "trace-7",
          linkedSessionId: "native-3",
          diagnosticText: "Exited with 1.",
        }}
      />
    )
    expect(screen.getByText(diag.sectionLatestRun)).toBeInTheDocument()
    expect(screen.getByText(diag.runOutcome.error)).toHaveClass("text-destructive")
    // `ok` is the success path, so no reason badge repeats it.
    expect(screen.queryByText("ok")).not.toBeInTheDocument()
    expect(screen.getByText("trace-7")).toBeInTheDocument()
    expect(screen.getByText("native-3")).toBeInTheDocument()
    expect(screen.getByText("Exited with 1.")).toBeInTheDocument()
  })
  it("formats a timestamp that arrived as an ISO string instead of printing it raw", () => {
    render(
      <ExternalAgentDiagnosticsPanel
        config={config}
        executable
        blockedReason={null}
        activity={activity}
        lastRun={{
          terminalOutcome: "ok",
          branchReasonCode: "ok",
          branchOutcome: "external",
          // Persistence and IPC hand the snapshot back with a string here.
          timestamp: "2026-09-23T10:43:26.003Z" as unknown as Date,
        }}
      />
    )
    expect(screen.getByText(diag.runOutcome.ok)).toBeInTheDocument()
    expect(screen.queryByText("2026-09-23T10:43:26.003Z")).not.toBeInTheDocument()
    expect(screen.getByText(/Sep 23, 2026/)).toBeInTheDocument()
  })

  it("does not prefix a clean contract reason with the raw `ok` code", () => {
    render(
      <ExternalAgentDiagnosticsPanel
        config={config}
        executable
        blockedReason={null}
        activity={activity}
      />
    )
    expect(valueOf(diag.field.reason)).toHaveTextContent(diag.noBlockingReason)
    expect(valueOf(diag.field.reason)).not.toHaveTextContent("ok —")
  })
})
