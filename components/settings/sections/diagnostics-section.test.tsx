/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("./diagnostic-service-card", () => ({
  DiagnosticServiceCard: () => <div data-testid="diagnostic-service-stub" />,
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

import { CRASH_REPORTS_HREF, DiagnosticsSection } from "./diagnostics-section"

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
  expect(screen.getByTestId("crash-reports-link-card")).toBeInTheDocument()
  expect(screen.queryByTestId("sandbox-audit-stub")).not.toBeInTheDocument()
})

// The reports themselves live in `/logs`; settings links there rather than
// keeping a second, weaker list of them.
it("links to the Crash reports channel instead of listing reports itself", () => {
  render(<DiagnosticsSection />)
  const card = screen.getByTestId("crash-reports-link-card")
  expect(card.querySelector("a")).toHaveAttribute("href", CRASH_REPORTS_HREF)
  expect(CRASH_REPORTS_HREF).toBe("/logs?channel=incidents")
})

it("switches to the system tab with the system cards", async () => {
  const user = userEvent.setup()
  render(<DiagnosticsSection />)
  await user.click(screen.getByRole("tab", { name: "System" }))
  expect(screen.getByTestId("developer-flags-stub")).toBeInTheDocument()
  expect(screen.getByTestId("sandbox-audit-stub")).toBeInTheDocument()
  expect(screen.getByTestId("sidecar-restart-stub")).toBeInTheDocument()
  expect(screen.getByTestId("inbox-telemetry-stub")).toBeInTheDocument()
  expect(screen.queryByTestId("crash-reports-link-card")).not.toBeInTheDocument()
})

it("returns to the native reports tab after visiting the system tab", async () => {
  const user = userEvent.setup()
  render(<DiagnosticsSection />)
  await user.click(screen.getByRole("tab", { name: "System" }))
  await user.click(screen.getByRole("tab", { name: "Native reports" }))
  expect(screen.getByTestId("crash-reports-link-card")).toBeInTheDocument()
  expect(screen.queryByTestId("sandbox-audit-stub")).not.toBeInTheDocument()
})

// Shared Tabs: a roving tab stop, arrow keys move focus and selection together, and
// each tab names the panel it controls.
it("moves selection with the arrow keys and associates tabs with their panels", async () => {
  const user = userEvent.setup()
  render(<DiagnosticsSection />)
  const nativeTab = screen.getByRole("tab", { name: "Native reports" })
  const systemTab = screen.getByRole("tab", { name: "System" })
  const panel = screen.getByRole("tabpanel")
  expect(nativeTab).toHaveAttribute("aria-controls", panel.id)
  expect(panel).toHaveAttribute("aria-labelledby", nativeTab.id)

  act(() => nativeTab.focus())
  await user.keyboard("{ArrowRight}")
  expect(systemTab).toHaveFocus()
  expect(nativeTab).toHaveAttribute("tabindex", "-1")
  expect(systemTab).toHaveAttribute("aria-selected", "true")
  expect(screen.getByTestId("sandbox-audit-stub")).toBeInTheDocument()

  await user.keyboard("{ArrowLeft}")
  expect(nativeTab).toHaveFocus()
  expect(nativeTab).toHaveAttribute("aria-selected", "true")
})
