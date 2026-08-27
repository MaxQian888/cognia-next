/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("./diagnostic-service-card", () => ({
  DiagnosticServiceCard: () => <div data-testid="diagnostic-service-stub" />,
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
jest.mock("./developer-flags-card", () => ({
  DeveloperFlagsCard: () => <div data-testid="developer-flags-stub" />,
}))

import { DiagnosticsSection } from "./diagnostics-section"

it("renders a labelled tablist with the two diagnostics tabs", () => {
  render(<DiagnosticsSection />)
  expect(screen.getByRole("tablist", { name: "Diagnostics sections" })).toBeInTheDocument()
  expect(screen.getAllByRole("tab")).toHaveLength(2)
  expect(screen.getByRole("tab", { name: "Native reports" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "System" })).toBeInTheDocument()
})

// The crash-log inspector moved to `/logs?channel=diagnostics`; the settings
// pane must not grow a third tab back.
it("no longer offers a crash-logs tab", () => {
  render(<DiagnosticsSection />)
  expect(screen.queryByRole("tab", { name: "Crash logs" })).not.toBeInTheDocument()
})

it("shows the native reports tab by default and hides the system cards", () => {
  render(<DiagnosticsSection />)
  expect(screen.getByRole("tab", { name: "Native reports" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  expect(screen.getByTestId("native-crash-reports-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("sandbox-audit-stub")).not.toBeInTheDocument()
})

it("switches to the system tab with the system cards", () => {
  render(<DiagnosticsSection />)
  fireEvent.click(screen.getByRole("tab", { name: "System" }))
  expect(screen.getByTestId("developer-flags-stub")).toBeInTheDocument()
  expect(screen.getByTestId("sandbox-audit-stub")).toBeInTheDocument()
  expect(screen.getByTestId("sidecar-restart-stub")).toBeInTheDocument()
  expect(screen.getByTestId("inbox-telemetry-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("native-crash-reports-stub")).not.toBeInTheDocument()
})

it("returns to the native reports tab after visiting the system tab", () => {
  render(<DiagnosticsSection />)
  fireEvent.click(screen.getByRole("tab", { name: "System" }))
  fireEvent.click(screen.getByRole("tab", { name: "Native reports" }))
  expect(screen.getByTestId("native-crash-reports-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("sandbox-audit-stub")).not.toBeInTheDocument()
})
