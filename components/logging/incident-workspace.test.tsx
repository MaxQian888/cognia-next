/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DiagnosticIncidentSummary } from "@/hooks/logging/use-diagnostic-incidents"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`,
}))

import {
  IncidentDetail,
  IncidentWorkspace,
  displayPreview,
  formatBytes,
} from "./incident-workspace"

const incident: DiagnosticIncidentSummary = {
  id: "incident-1",
  runtime: "desktop",
  source: "tauri-panic",
  capturedAt: "2026-08-01T08:00:00.000Z",
  state: "detected",
  sizeBytes: 2048,
  artifacts: ["report"],
} as DiagnosticIncidentSummary

const resize = {
  dragging: false,
  onPointerDown: jest.fn(),
  onPointerMove: jest.fn(),
  onPointerUp: jest.fn(),
  onKeyDown: jest.fn(),
  onDoubleClick: jest.fn(),
}

function renderWorkspace(over: Partial<React.ComponentProps<typeof IncidentWorkspace>> = {}) {
  const props = {
    incidents: [incident],
    loading: false,
    error: null,
    selected: null,
    preview: null,
    previewLoading: false,
    activeSource: "all" as const,
    incidentStateFilter: "all" as const,
    onSourceChange: jest.fn(),
    onStateChange: jest.fn(),
    onRefresh: jest.fn(),
    onSelect: jest.fn(),
    onDelete: jest.fn(),
    detailWidth: 384,
    detailResize: resize as unknown as React.ComponentProps<
      typeof IncidentWorkspace
    >["detailResize"],
    receiptsOnly: false,
    onReceiptsOnlyChange: jest.fn(),
    ...over,
  }
  return { props, ...render(<IncidentWorkspace {...props} />) }
}

describe("formatBytes", () => {
  it("scales through B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
  })
})

describe("displayPreview", () => {
  it("passes strings through and pretty-prints anything else", () => {
    expect(displayPreview("raw")).toBe("raw")
    expect(displayPreview(null)).toBe("")
    expect(displayPreview(undefined)).toBe("")
    expect(displayPreview({ a: 1 })).toContain('"a": 1')
  })
})

describe("IncidentWorkspace", () => {
  it("lists incidents with size and state", () => {
    renderWorkspace()
    const row = screen.getByTestId("incident-row")
    expect(row).toHaveTextContent("incident-1")
    expect(row).toHaveTextContent("2.0 KB")
    expect(row).toHaveTextContent("logging.workspace.states.detected")
  })

  it("selects an incident", () => {
    const { props } = renderWorkspace()
    fireEvent.click(screen.getByTestId("incident-row"))
    expect(props.onSelect).toHaveBeenCalledWith(incident)
  })

  it("keeps the state filter available in receipts-only mode", async () => {
    const user = userEvent.setup()
    const { props } = renderWorkspace({ receiptsOnly: true })
    // The old "Receipts" view hid this select; the filters compose now.
    expect(screen.getByLabelText("logging.workspace.filters.stateLabel")).toBeInTheDocument()
    await user.click(screen.getByTestId("incident-receipts-only"))
    expect(props.onReceiptsOnlyChange).toHaveBeenCalledWith(false)
  })

  it("swaps the empty state for the receipts wording when filtered", () => {
    renderWorkspace({ incidents: [] })
    expect(screen.getByText("logging.workspace.incidents.emptyTitle")).toBeInTheDocument()

    renderWorkspace({ incidents: [], receiptsOnly: true })
    expect(screen.getByText("logging.workspace.receipts.emptyTitle")).toBeInTheDocument()
  })

  it("shows the error alert instead of the list when the read failed", () => {
    renderWorkspace({ error: new Error("nope") })
    expect(screen.getByText("logging.workspace.incidents.error")).toBeInTheDocument()
    expect(screen.queryByTestId("incident-row")).not.toBeInTheDocument()
  })

  it("refreshes on demand and disables the control while loading", () => {
    const { props } = renderWorkspace()
    fireEvent.click(screen.getByText("logging.workspace.refresh"))
    expect(props.onRefresh).toHaveBeenCalled()

    renderWorkspace({ loading: true, incidents: [] })
    expect(
      screen.getAllByText("logging.workspace.refresh").at(-1)?.closest("button")
    ).toBeDisabled()
  })

  it("renders the wide detail pane only when an incident is selected", () => {
    renderWorkspace()
    expect(screen.queryByTestId("incident-detail-pane")).not.toBeInTheDocument()

    renderWorkspace({ selected: incident })
    expect(screen.getByTestId("incident-detail-pane")).toBeInTheDocument()
  })
})

describe("IncidentDetail", () => {
  it("renders the redacted preview and requires an explicit delete", () => {
    const onDelete = jest.fn()
    render(
      <IncidentDetail
        incident={incident}
        preview={{ redacted: true }}
        previewLoading={false}
        onDelete={onDelete}
      />
    )
    expect(screen.getByText(/"redacted": true/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("logging.workspace.delete.action"))
    expect(onDelete).toHaveBeenCalled()
  })

  it("leaves both optional attachments unchecked", () => {
    render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
      />
    )
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toHaveAttribute("data-state", "unchecked")
    }
  })

  it("shows a loading placeholder while the preview is read", () => {
    render(
      <IncidentDetail incident={incident} preview={null} previewLoading onDelete={jest.fn()} />
    )
    expect(screen.getByText("logging.workspace.detail.loading")).toBeInTheDocument()
  })
})
