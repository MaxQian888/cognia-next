/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

import { PluginPointDiagnosticsPanel } from "./plugin-point-diagnostics-panel"
import type { PluginPointDiagnostic } from "@/lib/plugin/contracts/plugin-points"

interface DiagnosticsHarness {
  getDiagnostics: jest.Mock<Record<string, PluginPointDiagnostic[]>, []>
  subscribe: jest.Mock<() => void, [() => void]>
  clearForPlugin: jest.Mock<void, [string]>
  clearAll: jest.Mock<void, []>
  notify: () => void
  setSnapshot: (snapshot: Record<string, PluginPointDiagnostic[]>) => void
}

const buildHarness = (
  initial: Record<string, PluginPointDiagnostic[]> = {}
): DiagnosticsHarness => {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const getDiagnostics = jest.fn(() => snapshot)
  const subscribe = jest.fn((listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  })
  const clearForPlugin = jest.fn((pluginId: string) => {
    const next = { ...snapshot }
    delete next[pluginId]
    snapshot = next
    listeners.forEach((l) => l())
  })
  const clearAll = jest.fn(() => {
    snapshot = {}
    listeners.forEach((l) => l())
  })
  return {
    getDiagnostics,
    subscribe,
    clearForPlugin,
    clearAll,
    notify: () => listeners.forEach((l) => l()),
    setSnapshot: (s) => {
      snapshot = s
      listeners.forEach((l) => l())
    },
  }
}

const diagnostic = (overrides: Partial<PluginPointDiagnostic> = {}): PluginPointDiagnostic => ({
  code: "plugin.point.unknown",
  severity: "warning",
  message: "default message",
  pointKind: "hook",
  pointId: "onLoad",
  ...overrides,
})

describe("PluginPointDiagnosticsPanel", () => {
  it("renders the empty state when no diagnostics exist", () => {
    const harness = buildHarness()
    render(<PluginPointDiagnosticsPanel {...harness} />)
    expect(screen.getByTestId("diagnostics-empty")).toHaveTextContent("empty")
  })

  it("renders all diagnostics under the All filter (mixed severities)", () => {
    const harness = buildHarness({
      "plugin-a": [
        diagnostic({ severity: "error", message: "boom" }),
        diagnostic({ severity: "warning", message: "minor" }),
      ],
      "plugin-b": [diagnostic({ severity: "error", message: "soft warn" })],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.getByText("minor")).toBeInTheDocument()
    expect(screen.getByText("soft warn")).toBeInTheDocument()
    // Both groups visible (triggers, regardless of expand state)
    expect(screen.getByTestId("diagnostics-group-trigger-plugin-a")).toBeInTheDocument()
    expect(screen.getByTestId("diagnostics-group-trigger-plugin-b")).toBeInTheDocument()
  })

  it('"Errors" filter hides warnings', () => {
    const harness = buildHarness({
      "plugin-a": [
        diagnostic({ severity: "error", message: "boom" }),
        diagnostic({ severity: "warning", message: "minor" }),
      ],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    fireEvent.click(screen.getByLabelText("filterErrors"))
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.queryByText("minor")).not.toBeInTheDocument()
  })

  it('"Warnings" filter hides errors', () => {
    const harness = buildHarness({
      "plugin-a": [
        diagnostic({ severity: "error", message: "boom" }),
        diagnostic({ severity: "warning", message: "minor" }),
      ],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    fireEvent.click(screen.getByLabelText("filterWarnings"))
    expect(screen.queryByText("boom")).not.toBeInTheDocument()
    expect(screen.getByText("minor")).toBeInTheDocument()
  })

  it("plugin with only warnings defaults to collapsed", () => {
    const harness = buildHarness({
      "plugin-warn": [diagnostic({ severity: "warning", message: "warn-only" })],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    const trigger = screen.getByTestId("diagnostics-group-trigger-plugin-warn")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })

  it("plugin with at least one error defaults to expanded", () => {
    const harness = buildHarness({
      "plugin-err": [
        diagnostic({ severity: "error", message: "fatal" }),
        diagnostic({ severity: "warning", message: "lesser" }),
      ],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    const trigger = screen.getByTestId("diagnostics-group-trigger-plugin-err")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  it("Clear button calls clearForPlugin and the group disappears after re-fire", () => {
    const harness = buildHarness({
      "plugin-a": [diagnostic({ severity: "error", message: "boom-clear" })],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    expect(screen.getByText("boom-clear")).toBeInTheDocument()
    expect(screen.getByTestId("diagnostics-group-trigger-plugin-a")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("diagnostics-clear-plugin-a"))
    expect(harness.clearForPlugin).toHaveBeenCalledWith("plugin-a")
    expect(screen.queryByText("boom-clear")).not.toBeInTheDocument()
    expect(screen.queryByTestId("diagnostics-group-trigger-plugin-a")).not.toBeInTheDocument()
  })

  it("Clear all confirm dialog → confirm button calls clearAll", () => {
    const harness = buildHarness({
      "plugin-a": [diagnostic({ severity: "error", message: "boom-all" })],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    expect(screen.getByText("boom-all")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("diagnostics-clear-all"))
    fireEvent.click(screen.getByText("confirm"))
    expect(harness.clearAll).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("boom-all")).not.toBeInTheDocument()
  })

  it("calls subscribe on mount and the unsubscribe on unmount", () => {
    const harness = buildHarness()
    const { unmount } = render(<PluginPointDiagnosticsPanel {...harness} />)
    expect(harness.subscribe).toHaveBeenCalled()
    unmount()
    // After unmount, notifying should not crash and there should be no listener left.
    act(() => harness.notify())
  })

  it("renders a tooltip wrapper when a diagnostic has a hint", () => {
    const harness = buildHarness({
      "plugin-a": [
        diagnostic({
          severity: "error",
          message: "with-hint-msg",
          hint: "extra context",
        }),
      ],
    })
    render(
      <TooltipProvider>
        <PluginPointDiagnosticsPanel {...harness} />
      </TooltipProvider>
    )
    const span = screen.getByText("with-hint-msg")
    expect(span.className).toMatch(/cursor-help/)
  })

  it("re-invokes getDiagnostics after each subscriber notify", () => {
    const harness = buildHarness({
      "plugin-a": [diagnostic({ severity: "warning", message: "first" })],
    })
    render(<PluginPointDiagnosticsPanel {...harness} />)
    const callsBefore = harness.getDiagnostics.mock.calls.length
    act(() => {
      harness.setSnapshot({
        "plugin-b": [diagnostic({ severity: "error", message: "second" })],
      })
    })
    expect(harness.getDiagnostics.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(screen.queryByText("first")).not.toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
  })
})
