/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { useLogWorkspaceStore } from "@/stores/logging/log-workspace-store"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}))

jest.mock("@/components/logging/log-panel", () => ({
  LogPanel: () => <div data-testid="embedded-log-panel" />,
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

jest.mock("@/hooks/logging/use-diagnostic-incidents", () => ({
  useDiagnosticIncidents: () => ({
    incidents: [mockIncident],
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
  useLogWorkspaceStore.getState().resetWorkspace()
})

describe("DiagnosticsWorkspace", () => {
  it("opens on the plain-language health view and exposes all workspace views", () => {
    render(<DiagnosticsWorkspace />)

    expect(screen.getByText("logging.workspace.health.title")).toBeInTheDocument()
    expect(screen.getAllByText("logging.workspace.views.logs").length).toBeGreaterThan(0)
    expect(screen.getAllByText("logging.workspace.views.incidents").length).toBeGreaterThan(0)
    expect(screen.getAllByText("logging.workspace.views.recovery").length).toBeGreaterThan(0)
  })

  it("embeds the existing LogPanel in the logs view", () => {
    render(<DiagnosticsWorkspace />)

    fireEvent.click(screen.getAllByText("logging.workspace.views.logs")[0])
    expect(screen.getByTestId("embedded-log-panel")).toBeInTheDocument()
  })

  it("previews a selected incident and deletes only after confirmation", async () => {
    render(<DiagnosticsWorkspace />)
    fireEvent.click(screen.getAllByText("logging.workspace.views.incidents")[0])
    fireEvent.click(screen.getByTestId("incident-row"))

    await waitFor(() => expect(mockRead).toHaveBeenCalledWith(mockIncident))
    expect(await screen.findAllByText(/"redacted": true/)).not.toHaveLength(0)

    fireEvent.click(screen.getAllByText("logging.workspace.delete.action")[0])
    expect(mockRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("logging.workspace.delete.confirm"))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith(mockIncident))
  })

  it("resets persisted workspace preferences from the header action", () => {
    useLogWorkspaceStore.getState().setActiveView("advanced")
    render(<DiagnosticsWorkspace />)

    fireEvent.click(screen.getByText("logging.workspace.reset"))
    expect(useLogWorkspaceStore.getState().activeView).toBe("health")
  })
})
