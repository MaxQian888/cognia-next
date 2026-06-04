/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("@/components/settings/system/crash-log-settings", () => ({
  CrashLogSettings: () => <div data-testid="crash-log-settings-stub" />,
}))
jest.mock("./native-crash-reports-card", () => ({
  NativeCrashReportsCard: () => <div data-testid="native-crash-reports-stub" />,
}))
jest.mock("./sandbox-audit-card", () => ({
  SandboxAuditCard: () => <div data-testid="sandbox-audit-stub" />,
}))
jest.mock("./sidecar-restart-card", () => ({
  SidecarRestartCard: () => <div data-testid="sidecar-restart-stub" />,
}))
jest.mock("./inbox-telemetry-card", () => ({
  InboxTelemetryCard: () => <div data-testid="inbox-telemetry-stub" />,
}))

import { DiagnosticsSection } from "./diagnostics-section"

it("renders a labelled tablist with the three diagnostics tabs", () => {
  render(<DiagnosticsSection />)
  expect(screen.getByRole("tablist", { name: "Diagnostics sections" })).toBeInTheDocument()
  expect(screen.getAllByRole("tab")).toHaveLength(3)
  expect(screen.getByRole("tab", { name: "Crash logs" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "Native reports" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "System" })).toBeInTheDocument()
})

it("shows the crash-log surface by default and hides the other tabs", () => {
  render(<DiagnosticsSection />)
  expect(screen.getByRole("tab", { name: "Crash logs" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByTestId("crash-log-settings-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("native-crash-reports-stub")).not.toBeInTheDocument()
  expect(screen.queryByTestId("sandbox-audit-stub")).not.toBeInTheDocument()
})

it("switches to the native reports tab", () => {
  render(<DiagnosticsSection />)
  fireEvent.click(screen.getByRole("tab", { name: "Native reports" }))
  expect(screen.getByRole("tab", { name: "Native reports" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  expect(screen.getByRole("tab", { name: "Crash logs" })).toHaveAttribute("aria-selected", "false")
  expect(screen.getByTestId("native-crash-reports-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("crash-log-settings-stub")).not.toBeInTheDocument()
})

it("switches to the system tab with the three system cards", () => {
  render(<DiagnosticsSection />)
  fireEvent.click(screen.getByRole("tab", { name: "System" }))
  expect(screen.getByTestId("sandbox-audit-stub")).toBeInTheDocument()
  expect(screen.getByTestId("sidecar-restart-stub")).toBeInTheDocument()
  expect(screen.getByTestId("inbox-telemetry-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("crash-log-settings-stub")).not.toBeInTheDocument()
  expect(screen.queryByTestId("native-crash-reports-stub")).not.toBeInTheDocument()
})

it("returns to the crash-log tab after visiting another tab", () => {
  render(<DiagnosticsSection />)
  fireEvent.click(screen.getByRole("tab", { name: "System" }))
  fireEvent.click(screen.getByRole("tab", { name: "Crash logs" }))
  expect(screen.getByTestId("crash-log-settings-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("sandbox-audit-stub")).not.toBeInTheDocument()
})
