/**
 * @jest-environment jsdom
 */
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { DiagnosticIncidentSummary } from "@/hooks/logging/use-diagnostic-incidents"
import {
  IDLE_SUBMISSION_STATE,
  type IncidentSubmissionState,
} from "@/hooks/logging/use-incident-submission"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`,
  useFormatter: () => ({
    dateTime: (value: Date) => value.toISOString(),
    number: (value: number, options?: { unit?: string }) =>
      options?.unit ? `${value} ${options.unit}` : String(value),
  }),
}))

// The detail is a pane at xl and a sheet below it, chosen in JS.
let wide = true
jest.mock("@/hooks/ui", () => ({
  ...jest.requireActual("@/hooks/ui"),
  useMediaQuery: () => wide,
}))

import {
  INCIDENT_STATES,
  IncidentDetail,
  IncidentWorkspace,
  displayPreview,
  formatByteSize,
  type IncidentSubmissionControls,
} from "./incident-workspace"

function render(ui: React.ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(() => {
  wide = true
})

/** Submission controls whose every incident is in `state`. */
function controls(
  over: Partial<IncidentSubmissionControls> & Partial<IncidentSubmissionState> = {}
): IncidentSubmissionControls {
  const { busy, errorCode, lastOutcome, ...rest } = over
  const state: IncidentSubmissionState = {
    ...IDLE_SUBMISSION_STATE,
    ...(busy !== undefined ? { busy } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(lastOutcome !== undefined ? { lastOutcome } : {}),
  }
  return {
    supported: true,
    checkingSupport: false,
    configured: true,
    stateFor: () => state,
    onSubmit: jest.fn(),
    onRefresh: jest.fn(),
    onWithdraw: jest.fn(),
    onDeleteRemote: jest.fn(),
    onConfigure: jest.fn(),
    ...rest,
  }
}

const incident: DiagnosticIncidentSummary = {
  id: "incident-1",
  runtime: "desktop",
  source: "panic",
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
    runtimes: ["desktop"] as const,
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

describe("formatByteSize", () => {
  it("scales through byte / kilobyte / megabyte with a localized unit", () => {
    const calls: Array<[number, Intl.NumberFormatOptions]> = []
    const format = {
      number: (value: number, options: Intl.NumberFormatOptions) => {
        calls.push([value, options])
        return `${value} ${options.unit}`
      },
    } as unknown as Parameters<typeof formatByteSize>[0]
    expect(formatByteSize(format, 512)).toBe("512 byte")
    expect(formatByteSize(format, 2048)).toBe("2 kilobyte")
    expect(formatByteSize(format, 5 * 1024 * 1024)).toBe("5 megabyte")
    expect(calls[0][1]).toMatchObject({ style: "unit", unitDisplay: "short" })
  })
})

describe("INCIDENT_STATES", () => {
  it("speaks the service vocabulary, packaged included", () => {
    expect(INCIDENT_STATES).toContain("awaiting_consent")
    expect(INCIDENT_STATES).toContain("packaged")
    expect(INCIDENT_STATES).not.toContain("awaitingConsent")
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
    expect(row).toHaveTextContent("2 kilobyte")
    expect(row).toHaveTextContent("logging.workspace.states.detected")
    // The capture source is translated, not the raw `panic`.
    expect(row).toHaveTextContent("logging.workspace.sources.panic")
  })

  it("labels an unrecognized capture source under a generic label", () => {
    renderWorkspace({ incidents: [{ ...incident, source: "future-collector" }] })
    expect(screen.getByTestId("incident-row")).toHaveTextContent(
      'logging.workspace.sources.other:{"source":"future-collector"}'
    )
  })

  it("hides the source filter unless both runtimes can hold reports", () => {
    renderWorkspace()
    expect(screen.queryByLabelText("logging.workspace.filters.sourceLabel")).toBeNull()

    renderWorkspace({ runtimes: ["desktop", "mobile"] })
    expect(screen.getByLabelText("logging.workspace.filters.sourceLabel")).toBeInTheDocument()
  })

  it("says a browser collects nothing rather than that nothing crashed", () => {
    renderWorkspace({ incidents: [], runtimes: [] })
    expect(screen.getByTestId("incident-uncollected")).toHaveTextContent(
      "logging.workspace.incidents.uncollectedTitle"
    )
    expect(screen.queryByText("logging.workspace.incidents.emptyTitle")).toBeNull()
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

  it("never mounts the sheet at xl, even after a row is clicked", () => {
    renderWorkspace({ selected: incident })
    fireEvent.click(screen.getByTestId("incident-row"))
    expect(screen.queryByTestId("incident-detail-drawer")).not.toBeInTheDocument()
  })

  it("uses a sheet below xl, opened only by a click", () => {
    wide = false
    renderWorkspace({ selected: incident })
    expect(screen.queryByTestId("incident-detail-pane")).not.toBeInTheDocument()
    expect(screen.queryByTestId("incident-detail-drawer")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("incident-row"))
    expect(screen.getByTestId("incident-detail-drawer")).toBeInTheDocument()
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
    // The local delete is an icon button in the header; the caller confirms.
    fireEvent.click(screen.getByRole("button", { name: "logging.workspace.delete.action" }))
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

  it("hides the form and says why on a device with no submission path", () => {
    render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ supported: false })}
      />
    )
    expect(screen.getByTestId("incident-submission-unsupported")).toHaveTextContent(
      "logging.workspace.submission.unsupported"
    )
    expect(screen.queryByTestId("incident-submit")).toBeNull()
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
  })

  it("waits for the mobile capability probe before offering anything", () => {
    render(
      <IncidentDetail
        incident={{ ...incident, runtime: "mobile", artifacts: ["report"] }}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls({ supported: false, checkingSupport: true })}
      />
    )
    expect(screen.getByTestId("incident-support-checking")).toBeInTheDocument()
    expect(screen.queryByTestId("incident-submission-unsupported")).toBeNull()
  })

  it("never offers a screenshot for a mobile report, whose path cannot take one", () => {
    render(
      <IncidentDetail
        incident={{ ...incident, runtime: "mobile", source: "ios-kscrash", artifacts: ["report"] }}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls()}
      />
    )
    expect(screen.queryByLabelText("logging.workspace.consent.screenshot")).toBeNull()
    expect(screen.getByTestId("incident-submit")).toBeEnabled()
  })

  it("shows a phone's receipt without remote actions it cannot perform", () => {
    render(
      <IncidentDetail
        incident={{
          ...incident,
          runtime: "mobile",
          state: "processing",
          receiptCode: "MOB-1",
          artifacts: ["report"],
        }}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={controls()}
      />
    )
    const receipt = screen.getByTestId("incident-receipt")
    expect(receipt).toHaveTextContent("MOB-1")
    expect(receipt).toHaveTextContent("logging.workspace.submission.mobileReceiptNote")
    expect(screen.queryByText("logging.workspace.submission.withdraw")).toBeNull()
    expect(screen.queryByTestId("incident-submit")).toBeNull()
  })

  it("reads state per incident, not hook-wide", () => {
    const stateFor = jest.fn((target: { id: string }) =>
      target.id === "incident-1" ? { ...IDLE_SUBMISSION_STATE, busy: true } : IDLE_SUBMISSION_STATE
    )
    const { unmount } = render(
      <IncidentDetail
        incident={incident}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={{ ...controls(), stateFor }}
      />
    )
    expect(screen.getByTestId("incident-submit")).toBeDisabled()
    unmount()
    render(
      <IncidentDetail
        incident={{ ...incident, id: "incident-2" }}
        preview={null}
        previewLoading={false}
        onDelete={jest.fn()}
        submission={{ ...controls(), stateFor }}
      />
    )
    expect(screen.getByTestId("incident-submit")).toBeEnabled()
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
    // The processing state is translated, not the raw enum.
    expect(
      screen.getByText("logging.workspace.console.processingStates.received")
    ).toBeInTheDocument()
    expect(screen.getByText("logging.workspace.submission.includedMinidump")).toBeInTheDocument()
    // Re-consenting to something already sent is not a thing.
    expect(screen.queryByTestId("incident-submit")).toBeNull()
  })

  it("confirms withdraw and remote delete before acting on a live submission", async () => {
    const user = userEvent.setup()
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
    await user.click(screen.getByText("logging.workspace.submission.withdraw"))
    expect(onWithdraw).not.toHaveBeenCalled()
    let dialog = within(await screen.findByTestId("incident-remote-confirm"))
    expect(
      dialog.getByText("logging.workspace.submission.confirmWithdrawTitle")
    ).toBeInTheDocument()
    await user.click(dialog.getByRole("button", { name: "logging.workspace.submission.withdraw" }))
    expect(onWithdraw).toHaveBeenCalledWith(submittedIncident)

    await user.click(screen.getByText("logging.workspace.submission.deleteRemote"))
    dialog = within(await screen.findByTestId("incident-remote-confirm"))
    // Cancelling sends nothing.
    await user.click(
      dialog.getByRole("button", { name: "logging.workspace.submission.confirmCancel" })
    )
    expect(onDeleteRemote).not.toHaveBeenCalled()

    await user.click(screen.getByText("logging.workspace.submission.deleteRemote"))
    dialog = within(await screen.findByTestId("incident-remote-confirm"))
    await user.click(
      dialog.getByRole("button", { name: "logging.workspace.submission.deleteRemote" })
    )
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
