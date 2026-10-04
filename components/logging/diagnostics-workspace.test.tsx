/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { useLogWorkspaceStore } from "@/stores/logging/log-workspace-store"

/** `TooltipProvider` is mounted once in `app/layout.tsx`; the header's health
 * chip is a tooltip trigger, so the bare render has to supply it here. */
const render = (ui: React.ReactElement) =>
  rtlRender(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`
    t.has = () => true
    return t
  },
  useFormatter: () => ({
    dateTime: (value: Date | number) => new Date(value).toISOString(),
    number: (value: number) => String(value),
    relativeTime: (value: Date | number) => new Date(value).toISOString(),
  }),
}))

const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
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
    roleStatus: "unknown",
    roleErrorCode: null,
    probeRole: jest.fn(),
    reachable: true,
    client: null,
    can: () => false,
    connect: jest.fn(),
    disconnect: jest.fn(),
    reload: jest.fn(),
  }),
}))
jest.mock("@/hooks/logging/use-incident-submission", () => ({
  ...jest.requireActual("@/hooks/logging/use-incident-submission"),
  useIncidentSubmission: () => ({
    supported: false,
    checkingSupport: false,
    configured: false,
    stateFor: () => ({ busy: false, errorCode: null, lastOutcome: null }),
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
  // Wide: the incident detail is the side pane, not a sheet.
  useMediaQuery: () => true,
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
  summarizeTransportHealth: jest.requireActual("@/hooks/logging/use-transport-health")
    .summarizeTransportHealth,
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
const mockReceiptIncident = {
  ...mockIncident,
  id: "incident-2",
  receiptCode: "RC-9",
  state: "submitted",
}

jest.mock("@/hooks/logging/use-diagnostic-incidents", () => ({
  ...jest.requireActual("@/hooks/logging/use-diagnostic-incidents"),
  useDiagnosticIncidents: () => ({
    runtimes: ["mobile"],
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

  it("keeps channel labels for headers wide enough to hold them beside the title", () => {
    render(<DiagnosticsWorkspace />)
    const tab = screen.getByTestId("logs-channel-logs")
    // Icon-only below the breakpoint, so the name must not depend on the label;
    // the tooltip adds what the channel holds.
    expect(tab.getAttribute("title")).toBe(
      `${tab.getAttribute("aria-label")} — logging.workspace.viewDescriptions.logs`
    )
    const label = screen.getByTestId("logs-channel-logs-label")
    expect(label).toHaveClass("hidden", "@5xl/feature-header:inline")
  })

  it("aggregates live transport health into a single header chip", () => {
    render(<DiagnosticsWorkspace />)
    const chip = screen.getByTestId("logs-status-strip")
    // one of two transports is degraded, so the chip reads 1/2 and warns
    expect(chip).toHaveTextContent("1/2")
    expect(chip).toHaveAttribute("data-health", "attention")
    // the breakdown the three old badges carried lives in the accessible name
    // A link to the breakdown it summarizes, not a button with no handler.
    const name = screen.getByRole("link", { name: /logging.workspace.status.transports/ })
    expect(name).toHaveAttribute("href", "/settings?section=logs&logsPanel=overview")
    expect(name).toHaveAccessibleName(/"healthy":1/)
    expect(name).toHaveAccessibleName(/"total":2/)
    expect(name).toHaveAccessibleName(/logging.workspace.status.native/)
    expect(name).toHaveAccessibleName(/logging.workspace.status.incidents/)
  })

  it("badges only the crash reports still waiting on the user", () => {
    render(<DiagnosticsWorkspace />)
    // The receipt-carrying report is the service's to process.
    expect(screen.getByTestId("logs-channel-incidents-count")).toHaveTextContent("1")
  })

  it("points Configure at the settings for the channel on screen", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    expect(screen.getByTestId("logs-configure")).toHaveAttribute("href", "/settings?section=logs")
    await user.click(screen.getByTestId("logs-channel-incidents"))
    expect(screen.getByTestId("logs-configure")).toHaveAttribute(
      "href",
      "/settings?section=diagnostics"
    )
  })

  it("mirrors the Traces sub-view into ?tview= and adopts it from a link", () => {
    mockSearchParams.mockReturnValue(new URLSearchParams("channel=traces&tview=dashboard"))
    render(<DiagnosticsWorkspace />)
    expect(useLogWorkspaceStore.getState().traceSubView).toBe("dashboard")
    const props = traceWorkspaceProps.mock.calls.at(-1)![0] as {
      onSubViewChange: (view: "explore" | "dashboard") => void
    }
    act(() => props.onSubViewChange("explore"))
    expect(new URLSearchParams(window.location.search).get("tview")).toBeNull()
    act(() => props.onSubViewChange("dashboard"))
    expect(new URLSearchParams(window.location.search).get("tview")).toBe("dashboard")
  })

  it("follows an in-app link to another channel while already mounted", () => {
    const { rerender } = render(<DiagnosticsWorkspace />)
    expect(screen.getByTestId("embedded-log-panel")).toBeInTheDocument()
    mockSearchParams.mockReturnValue(new URLSearchParams("channel=traces&traceId=t-9"))
    rerender(
      <TooltipProvider delayDuration={0}>
        <DiagnosticsWorkspace />
      </TooltipProvider>
    )
    expect(screen.getByTestId("embedded-trace-workspace")).toBeInTheDocument()
    expect(traceWorkspaceProps.mock.calls.at(-1)![0]).toMatchObject({ selectedTraceId: "t-9" })
  })

  it("shares the header's single health poll with the log panel", () => {
    render(<DiagnosticsWorkspace />)
    const props = logPanelProps.mock.calls.at(-1)![0] as {
      transportHealth?: { healthByTransport: Record<string, unknown> }
    }
    expect(Object.keys(props.transportHealth?.healthByTransport ?? {})).toEqual([
      "indexeddb",
      "remote",
    ])
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
    expect(traceWorkspaceProps).toHaveBeenCalledWith(
      expect.objectContaining({ subView: "explore", onSubViewChange: expect.any(Function) })
    )
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

  it("opens an agent trace from the logs channel in the Traces explorer", () => {
    render(<DiagnosticsWorkspace />)
    const props = logPanelProps.mock.calls.at(-1)?.[0] as { onOpenTrace: (id: string) => void }
    act(() => props.onOpenTrace("trace-77"))

    expect(screen.getByTestId("embedded-trace-workspace")).toBeInTheDocument()
    expect(traceWorkspaceProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedTraceId: "trace-77", subView: "explore" })
    )
    const params = new URLSearchParams(window.location.search)
    expect(params.get("channel")).toBe("traces")
    expect(params.get("traceId")).toBe("trace-77")
  })

  it("writes a restored channel into the address bar", () => {
    useLogWorkspaceStore.getState().setActiveView("service")
    render(<DiagnosticsWorkspace />)
    expect(new URLSearchParams(window.location.search).get("channel")).toBe("service")
  })

  it("keeps a bare URL bare when the restored channel is Logs", () => {
    render(<DiagnosticsWorkspace />)
    expect(window.location.search).toBe("")
  })

  it("previews a selected incident and deletes only after confirmation", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-incidents"))
    fireEvent.click(screen.getAllByTestId("incident-row")[0])

    await waitFor(() => expect(mockRead).toHaveBeenCalledWith(mockIncident))
    expect(await screen.findAllByText(/"redacted": true/)).not.toHaveLength(0)

    fireEvent.click(screen.getByTestId("incident-delete-local"))
    expect(mockRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("logging.workspace.delete.confirm"))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith(mockIncident))
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("logging.workspace.delete.done")
    )
  })

  it("reads the preview of the auto-selected report and makes the selection linkable", async () => {
    const user = userEvent.setup()
    render(<DiagnosticsWorkspace />)
    await user.click(screen.getByTestId("logs-channel-incidents"))
    // No click: the first report is shown, so its preview is read.
    await waitFor(() => expect(mockRead).toHaveBeenCalledWith(mockIncident))
    fireEvent.click(screen.getAllByTestId("incident-row")[1])
    expect(new URLSearchParams(window.location.search).get("incident")).toBe("mobile:incident-2")
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
