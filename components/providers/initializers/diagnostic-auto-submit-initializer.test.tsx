/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

import type { AutoSubmitOutcome } from "@/lib/diagnostic-service/auto-submit"

const push = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}))

const toastSuccess = jest.fn()
const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}))

let captured: ((outcomes: AutoSubmitOutcome[]) => void) | null = null
jest.mock("@/hooks/diagnostic-service/use-diagnostic-auto-submit", () => ({
  useDiagnosticAutoSubmit: (options: { onOutcomes: (outcomes: AutoSubmitOutcome[]) => void }) => {
    captured = options.onOutcomes
    return "idle"
  },
}))

import {
  CRASH_REPORTS_HREF,
  DiagnosticAutoSubmitInitializer,
} from "./diagnostic-auto-submit-initializer"

const incident = {
  id: "crash-1",
  runtime: "desktop" as const,
  source: "panic",
  capturedAt: "2026-10-02T00:00:00.000Z",
  state: "detected",
}

beforeEach(() => {
  captured = null
  push.mockClear()
  toastSuccess.mockClear()
  toastWarning.mockClear()
})

describe("DiagnosticAutoSubmitInitializer", () => {
  it("renders nothing", () => {
    const { container } = render(<DiagnosticAutoSubmitInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows each automatic submission's support code as its receipt", () => {
    render(<DiagnosticAutoSubmitInitializer />)
    captured!([
      {
        kind: "submitted",
        incident,
        receipt: {
          uploadedParts: 2,
          resumedParts: 0,
          screenshotUnavailable: false,
          supportCode: "SUP-9",
          clientState: "processing",
        },
      },
    ])
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0][0]).toBe("Crash report sent · support code SUP-9")
    // The receipt links to where it is kept.
    toastSuccess.mock.calls[0][1].action.onClick()
    expect(push).toHaveBeenCalledWith(CRASH_REPORTS_HREF)
    expect(CRASH_REPORTS_HREF).toBe("/logs?channel=incidents")
  })

  it("says when sends failed, and whether a later launch will retry", () => {
    render(<DiagnosticAutoSubmitInitializer />)
    captured!([
      { kind: "failed", incident, errorCode: "network_unavailable", willRetry: true },
      {
        kind: "failed",
        incident: { ...incident, id: "crash-2" },
        errorCode: "x",
        willRetry: false,
      },
    ])
    expect(toastWarning).toHaveBeenCalledTimes(1)
    expect(toastWarning.mock.calls[0][0]).toBe("2 crash reports could not be sent")
    expect(toastWarning.mock.calls[0][1].description).toBe(
      "They stay on this device and will be tried again on the next launch."
    )

    toastWarning.mockClear()
    captured!([{ kind: "failed", incident, errorCode: "unauthorized", willRetry: false }])
    expect(toastWarning.mock.calls[0][0]).toBe("A crash report could not be sent")
    expect(toastWarning.mock.calls[0][1].description).toBe(
      "They stay on this device. Review and send them from Logs → Crash reports."
    )
  })
})
