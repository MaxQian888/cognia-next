/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react"
import { createDiagnostic } from "@cognia/diagnostics"

import { DiagnosticNotifier } from "./diagnostic-notifier"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"

const notifyMock = jest.fn().mockResolvedValue("n1")
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}))

const diag = (code: Parameters<typeof createDiagnostic>[0], init = {}) =>
  createDiagnostic(code, { source: "storage", now: () => Date.now(), ...init })

beforeEach(() => {
  notifyMock.mockClear()
})

describe("DiagnosticNotifier", () => {
  it("resolves the code to a localized title instead of filing a raw identifier", () => {
    render(<DiagnosticNotifier />)
    act(() => {
      dispatchDiagnostic(diag("seedFailed", { message: "seed threw" }))
    })

    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock.mock.calls[0][0]).toMatchObject({
      source: "system",
      level: "warning",
      title: "Built-in content missing",
      body: "seed threw",
      dedupeKey: "seedFailed:global",
    })
  })

  it("scopes the dedupe key so a flapping agent produces one counted row", () => {
    render(<DiagnosticNotifier />)
    act(() => {
      dispatchDiagnostic(diag("healthCheckFailed", { meta: { agentId: "a1" } }))
    })
    expect(notifyMock.mock.calls[0][0]).toMatchObject({ dedupeKey: "healthCheckFailed:a1" })
  })

  it("collapses a burst into one aggregate record", () => {
    render(<DiagnosticNotifier />)
    act(() => {
      dispatchDiagnostic(diag("eventChannelLost"))
      dispatchDiagnostic(diag("eventChannelLost"))
      dispatchDiagnostic(diag("eventChannelLost"))
      dispatchDiagnostic(diag("eventChannelLost"))
    })
    // One incident, not four: a dead event channel breaks every subscription
    // at once.
    const titles = notifyMock.mock.calls.map((c) => (c[0] as { title: string }).title)
    expect(titles.slice(0, 2)).toEqual(["Live updates disconnected", "Live updates disconnected"])
    expect(titles.slice(2)).toEqual(["3 problems", "4 problems"])
  })

  it("carries only actions that survive without a live surface", () => {
    render(<DiagnosticNotifier />)
    act(() => {
      dispatchDiagnostic(diag("dbUpgradeBlocked"))
    })
    const input = notifyMock.mock.calls[0][0] as { actions?: { id: string; label: string }[] }
    expect(input.actions).toEqual([
      { id: "reload-app", label: "Reload app", command: "diagnostic.reload-app" },
    ])
  })

  it("escalates a fatal to critical so DND cannot swallow it", () => {
    render(<DiagnosticNotifier />)
    act(() => {
      dispatchDiagnostic(diag("dbUnavailable"))
    })
    expect(notifyMock.mock.calls[0][0]).toMatchObject({ level: "critical", directed: true })
  })

  it("does not throw when the notification write rejects", () => {
    // The structured log line was already written by `dispatchDiagnostic`, so
    // the failure is not lost — but a throw here would escape a DOM listener.
    notifyMock.mockRejectedValueOnce(new Error("dexie down"))
    render(<DiagnosticNotifier />)
    expect(() =>
      act(() => {
        dispatchDiagnostic(diag("seedFailed"))
      })
    ).not.toThrow()
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<DiagnosticNotifier />)
    unmount()
    act(() => {
      dispatchDiagnostic(diag("seedFailed"))
    })
    expect(notifyMock).not.toHaveBeenCalled()
  })
})
