/**
 * @jest-environment jsdom
 */
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { useLogWorkspaceStore } from "@/stores/logging/log-workspace-store"

/** `TooltipProvider` is mounted once in `app/layout.tsx`; the header's health
 * chip is a tooltip trigger, so the bare render has to supply it here. */
const render = (ui: React.ReactElement) =>
  rtlRender(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}))

const mockSearchParams = jest.fn<URLSearchParams | null, []>()
const mockRouterPush = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams(),
  useRouter: () => ({ push: mockRouterPush }),
}))

// Both diagnostic-service hooks are mocked rather than exercised here: the
// connection hook reaches the account store, which pulls in the agent-team and
// workflow graphs, and this suite is about channel routing. Their own suites
// cover them, and `incident-workspace.test.tsx` covers the panel they feed.
jest.mock("@/hooks/diagnostic-service/use-diagnostic-connection", () => ({
  useDiagnosticConnection: () => ({
    accountId: "account-a",
    connection: null,
    authenticated: false,
    loading: false,
    role: null,
    reachable: true,
    client: null,
    can: () => false,
    connect: jest.fn(),
    disconnect: jest.fn(),
    reload: jest.fn(),
  }),
}))
jest.mock("@/hooks/logging/use-incident-submission", () => ({
  useIncidentSubmission: () => ({
    supported: false,
    configured: false,
    busy: false,
    errorCode: null,
    lastOutcome: null,
    onSubmit: jest.fn(),
    onRefresh: jest.fn(),
    onWithdraw: jest.fn(),
    onDeleteRemote: jest.fn(),
    onConfigure: jest.fn(),
  }),
}))

const logPanelProps = jest.fn()
jest.mock("@/components/logging/log-panel", () => ({
  LogPanel: (props: Record<string, unknown>) => {
    logPanelProps(props)
    return <div data-testid="embedded-log-panel" />
  },
}))

const traceWorkspaceProps = jest.fn()
jest.mock("@/components/logging/trace-workspace", () => ({
  TraceWorkspace: (props: Record<string, unknown>) => {
    traceWorkspaceProps(props)
    return (
      <div data-testid="embedded-trace-workspace">
        <button
          type="button"
          data-testid="stub-open-in-logs"
          onClick={() => (props.onOpenInLogs as (id: string) => void)("trace-42")}
        />
      </div>
    )
  },
}))

jest.mock("@/hooks/ui", () => ({
  useIsNarrow: () => false,
  useEdgeResize: () => ({
    dragging: false,
    onPointerDown: jest.fn(),
    onPointerMove: jest.fn(),
    onPointerUp: jest.fn(),
    onKeyDown: jest.fn(),
    onDoubleClick: jest.fn(),
  }),
}))

jest.mock("@/hooks/logging", () => ({
  useTransportHealth: () => ({
    nativeLogging: { status: "healthy" },
    healthByTransport: {
      indexeddb: { transport: "indexeddb", status: "healthy" },
      remote: { transport: "remote", status: "degraded" },
    },
  }),
}))

const mockRead = jest.fn(async () => ({ redacted: true }))
const mockRemove = jest.fn(async () => true)
const mockRefresh = jest.fn(async () => undefined)
const mockIncident = {
  id: "incident-1",
  runtime: "mobile" as const,
  source: "ios-kscrash",
  capturedAt: "2026-08-01T08:00:00.000Z",
  state: "detected",
  sizeBytes: 512,
  artifacts: ["report" as const],
}
const mockReceiptIncident = { ...mockIncident, id: "incident-2", receiptCode: "RC-9" }

jest.mock("@/hooks/logging/use-diagnostic-incidents", () => ({
  useDiagnosticIncidents: () => ({
    incidents: [mockIncident, mockReceiptIncident],
    loading: false,
    error: null,
    refresh: mockRefresh,
    read: mockRead,
    remove: mockRemove,
  }),
}))

import { DiagnosticsWorkspace } from "./diagnostics-workspace"

beforeEach(() => {
  jest.clearAllMocks()
  mockSearchParams.mockReturnValue(new URLSearchParams())
  window.history.replaceState({}, "", "/logs")
  useLogWorkspaceStore.getState().resetWorkspace()
})

describe("DiagnosticsWorkspace", () => {
  it("opens on the logs channel with the log panel already mounted", () => {
    render(<DiagnosticsWorkspace />)
    expect(screen.getByTestId("embedded-log-panel")).toBeInTheDocument()
    expect(screen.getByTestId("diagnostics-workspace")).toHaveAttribute("data-channel", "logs")
  })

  it("mounts the log panel with agent-trace enabled", () => {
    render(<DiagnosticsWorkspace />)
    expect(logPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({ includeAgentTrace: true, showStats: true, showTimeline: true })
    )
  })

  it("exposes exactly three channels — no static health/recovery/advanced views", () => {
    render(<DiagnosticsWorkspace />)
    expect(screen.getByTestId("logs-channel-logs")).toBeInTheDocument()
    expect(screen.getByTestId("logs-channel-traces")).toBeInTheDocument()
    expect(screen.getByTestId("logs-channel-incidents")).toBeInTheDocument()
    expect(screen.queryByText("logging.workspace.views.health")).not.toBeInTheDocument()
    expect(screen.queryByText("logging.workspace.views.recovery")).not.toBeInTheDocument()
    expect(screen.queryByText("logging.workspace.views.advanced")).not.toBeInTheDocument()
  })

  it("aggregates live transport health into a single header chip", () => {
    render(<DiagnosticsWorkspace />)
    const chip = screen.getByTestId("logs-status-strip")
    // one of two transports is degraded, so the chip reads 1/2 and warns
    expect(chip).toHaveTextContent("1/2")
    expect(chip).toHaveAttribute("data-health", "attention")
    // the breakdown the three old badges carried lives in the accessible name
    const name = screen.getByRole("button", { name: /logging.workspace.status.transports/ })
    expect(name).toHaveAccessibleName(/"healthy":1/)
    expect(name).toHaveAccessibleName(/"total":2/)
    expect(name).toHaveAccessibleName(/logging.workspace.status.native/)
    expect(name).toHaveAccessibleName(/logging.workspace.status.incidents/)
  })

  it("badges the incident count on the channel it belongs to", () => {
    render(<DiagnosticsWorkspace />)
    expect(screen.getByTestId("logs-channel-incidents-count")).toHaveTextContent("2")
  })

  it("feeds the workspace density into the log panel instead of shadowing it", () => {
    useLogWorkspaceStore.getState().setDensity("spacious")
    render(<DiagnosticsWorkspace />)
    expect(logPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({ density: "spacious", onDensityChange: expect.any(Function) })
    )
  })

  it("keeps the header to a single row — the channel tabs moved into it", () => {
    render(<DiagnosticsWorkspace />)
    const header = screen.getByTestId("logs-page-header")
    expect(header).toHaveAttribute("data-navigation-placement", "inline")
    expect(header).toHaveAttribute("data-has-secondary", "false")
  })

  it("switches to the traces channel and mirrors it into the URL", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-traces"))
    expect(screen.getByTestId("embedded-trace-workspace")).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get("channel")).toBe("traces")
  })

  it("opens the diagnostic service console on its own channel", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-service"))
    // Unconfigured is the honest first state: the mocked connection has no
    // service, and the console says so with a way to configure one rather than
    // rendering an empty triage list that reads as "no crashes".
    expect(screen.getByTestId("console-unconfigured")).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get("channel")).toBe("service")
  })

  it("drops the channel param again on the default channel", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-traces"))
    await user.click(screen.getByTestId("logs-channel-logs"))
    expect(new URLSearchParams(window.location.search).get("channel")).toBeNull()
  })

  it("honours a ?channel= deep link over the persisted channel", () => {
    useLogWorkspaceStore.getState().setActiveView("incidents")
    mockSearchParams.mockReturnValue(new URLSearchParams("channel=traces&traceId=abc"))
    render(<DiagnosticsWorkspace />)
    expect(screen.getByTestId("embedded-trace-workspace")).toBeInTheDocument()
    expect(traceWorkspaceProps).toHaveBeenCalledWith(
      expect.objectContaining({ selectedTraceId: "abc" })
    )
  })

  it("jumps from a span back into the logs channel focused on its trace", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-traces"))
    fireEvent.click(screen.getByTestId("stub-open-in-logs"))

    expect(screen.getByTestId("embedded-log-panel")).toBeInTheDocument()
    const params = new URLSearchParams(window.location.search)
    expect(params.get("trace")).toBe("trace-42")
    expect(params.get("channel")).toBeNull()
    expect(params.get("traceId")).toBeNull()
  })

  it("previews a selected incident and deletes only after confirmation", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-incidents"))
    fireEvent.click(screen.getAllByTestId("incident-row")[0])

    await waitFor(() => expect(mockRead).toHaveBeenCalledWith(mockIncident))
    expect(await screen.findAllByText(/"redacted": true/)).not.toHaveLength(0)

    fireEvent.click(screen.getAllByText("logging.workspace.delete.action")[0])
    expect(mockRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("logging.workspace.delete.confirm"))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith(mockIncident))
  })

  it("narrows the incident list to receipts when the toggle is pressed", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-incidents"))
    expect(screen.getAllByTestId("incident-row")).toHaveLength(2)

    await user.click(screen.getByTestId("incident-receipts-only"))
    const rows = screen.getAllByTestId("incident-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("RC-9")
  })

  it("resets persisted workspace preferences from the header overflow menu", async () => {
    const user = userEvent.setup()
    useLogWorkspaceStore.getState().setActiveView("incidents")
    useLogWorkspaceStore.getState().setReceiptsOnly(true)
    render(<DiagnosticsWorkspace />)

    await user.click(screen.getByRole("button", { name: "logging.workspace.moreActions" }))
    await user.click(await screen.findByTestId("logs-reset-workspace"))
    expect(useLogWorkspaceStore.getState().activeView).toBe("logs")
    expect(useLogWorkspaceStore.getState().receiptsOnly).toBe(false)
  })
})
