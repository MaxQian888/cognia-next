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
  type IncidentSubmissionControls,
} from "./incident-workspace"

function controls(over: Partial<IncidentSubmissionControls> = {}): IncidentSubmissionControls {
  return {
    supported: true,
    configured: true,
    busy: false,
    errorCode: null,
    lastOutcome: null,
    onSubmit: jest.fn(),
    onRefresh: jest.fn(),
    onWithdraw: jest.fn(),
    onDeleteRemote: jest.fn(),
    onConfigure: jest.fn(),
    ...over,
  }
}

const incident: DiagnosticIncidentSummary = {
  id: "incident-1",
  runtime: "desktop",
  source: "tauri-panic",
  capturedAt: "2026-08-01T08:00:00.000Z",
  state: "detected",
  sizeBytes: 2048,
  artifacts: ["report"],
} as DiagnosticIncidentSummary

const submittedIncident: DiagnosticIncidentSummary = {
  ...incident,
  state: "processing",
  receiptCode: "ABC123",
  submission: {
    incidentId: "inc-1",
    supportCode: "ABC123",
    clientState: "processing",
    processingState: "received",
    serviceUrl: "https://diag.example.com",
    submittedAt: "2026-08-20T00:00:00.000Z",
    includedMinidump: true,
    includedScreenshot: false,
  },
}

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

describe("IncidentDetail submission", () => {
  it("sends exactly the consent the user gave, and nothing it did not", async () => {
    const onSubmit = jest.fn()
    // A minidump checkbox only appears when a `.dmp` was actually captured; a
    // checkbox that sends nothing is the lie this panel already had once.
    const withDump: DiagnosticIncidentSummary = {
      ...incident,
      artifacts: ["text", "metadata", "minidump"],
    }
    render(
      <IncidentDetail
        incident={withDump}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ onSubmit })}
      />
    )

    await userEvent.click(screen.getByLabelText("logging.workspace.consent.minidump"))
    await userEvent.type(
      screen.getByLabelText("logging.workspace.consent.descriptionLabel"),
      "it died on export"
    )
    await userEvent.click(screen.getByTestId("incident-submit"))

    expect(onSubmit).toHaveBeenCalledWith(withDump, {
      includeMinidump: true,
      includeScreenshot: false,
      description: "it died on export",
    })
  })

  it("never offers a minidump the report does not have", () => {
    render(
      <IncidentDetail
        incident={{ ...incident, artifacts: ["text"] }}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls()}
      />
    )
    expect(screen.queryByLabelText("logging.workspace.consent.minidump")).toBeNull()
    expect(screen.getByLabelText("logging.workspace.consent.screenshot")).toBeInTheDocument()
  })

  it("cannot submit without a configured service, and offers a way to configure one", async () => {
    const onConfigure = jest.fn()
    const onSubmit = jest.fn()
    render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ configured: false, onConfigure, onSubmit })}
      />
    )
    expect(screen.getByTestId("incident-submit")).toBeDisabled()
    await userEvent.click(screen.getByText("logging.workspace.submission.configure"))
    expect(onConfigure).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("says so plainly off the desktop shell instead of failing on click", () => {
    render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ supported: false })}
      />
    )
    expect(screen.getByText("logging.workspace.submission.desktopOnly")).toBeInTheDocument()
    expect(screen.getByTestId("incident-submit")).toBeDisabled()
  })

  it("renders the receipt instead of the consent panel once submitted", () => {
    render(
      <IncidentDetail
        incident={submittedIncident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls()}
      />
    )
    expect(screen.getByTestId("incident-receipt")).toBeInTheDocument()
    expect(screen.getByText("ABC123")).toBeInTheDocument()
    expect(screen.getByText("logging.workspace.submission.includedMinidump")).toBeInTheDocument()
    // Re-consenting to something already sent is not a thing.
    expect(screen.queryByTestId("incident-submit")).toBeNull()
  })

  it("offers withdraw and remote delete on a live submission", async () => {
    const onWithdraw = jest.fn()
    const onDeleteRemote = jest.fn()
    render(
      <IncidentDetail
        incident={submittedIncident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ onWithdraw, onDeleteRemote })}
      />
    )
    await userEvent.click(screen.getByText("logging.workspace.submission.withdraw"))
    await userEvent.click(screen.getByText("logging.workspace.submission.deleteRemote"))
    expect(onWithdraw).toHaveBeenCalledWith(submittedIncident)
    expect(onDeleteRemote).toHaveBeenCalledWith(submittedIncident)
  })

  it("hides the remote actions once consent has already been withdrawn", () => {
    render(
      <IncidentDetail
        incident={{
          ...submittedIncident,
          submission: {
            ...submittedIncident.submission!,
            withdrawnAt: "2026-08-20T01:00:00.000Z",
          },
        }}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls()}
      />
    )
    expect(screen.getByText("logging.workspace.submission.withdrawn")).toBeInTheDocument()
    expect(screen.queryByText("logging.workspace.submission.withdraw")).toBeNull()
  })

  it("translates a failure code and falls back for one it does not know", () => {
    const { unmount } = render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ errorCode: "ingest_disabled" })}
      />
    )
    expect(screen.getByTestId("incident-submit-error")).toHaveTextContent(
      "logging.workspace.submission.errors.ingest_disabled"
    )
    unmount()

    render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ errorCode: "something_new_from_the_service" })}
      />
    )
    // Never raw service prose: an unknown code degrades to the generic string.
    expect(screen.getByTestId("incident-submit-error")).toHaveTextContent(
      "logging.workspace.submission.errors.submission_failed"
    )
  })

  it("admits when a requested screenshot could not be captured", () => {
    render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({
          lastOutcome: { uploadedParts: 3, resumedParts: 1, screenshotUnavailable: true },
        })}
      />
    )
    const outcome = screen.getByTestId("incident-submit-outcome")
    expect(outcome).toHaveTextContent('{"uploaded":3,"resumed":1}')
    expect(outcome).toHaveTextContent("logging.workspace.submission.screenshotUnavailable")
  })

  it("keeps the panel inert while a submission is in flight", () => {
    render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ busy: true })}
      />
    )
    expect(screen.getByTestId("incident-submit")).toBeDisabled()
    expect(screen.getByTestId("incident-submit")).toHaveTextContent(
      "logging.workspace.submission.submitting"
    )
  })
})
