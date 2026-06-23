import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ErrorDiagnosticsCard, type ErrorDiagnosticsCopy } from "./error-diagnostics-card"
import type { LocalRuntimeDiagnostics } from "@/lib/native/local-runtime"

const mockStatus = { connected: true, connectionType: "wifi" as const }
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: mockStatus }),
}))

const copy: ErrorDiagnosticsCopy = {
  title: "System diagnostics",
  appVersion: "App version",
  platform: "Platform",
  osVersion: "OS version",
  runtime: "Runtime",
  online: "Online",
  offline: "Offline",
  locale: "Locale",
  route: "Route",
  category: "Category",
  runtimeDesktop: "Desktop",
  runtimeBrowser: "Browser",
}

function renderCard(
  diagnostics: LocalRuntimeDiagnostics | null,
  overrides?: Partial<React.ComponentProps<typeof ErrorDiagnosticsCard>>
) {
  return render(
    <ErrorDiagnosticsCard
      copy={copy}
      categoryLabel="Render error"
      locale="en"
      pathname="/dashboard"
      getDiagnostics={jest.fn().mockResolvedValue(diagnostics)}
      {...overrides}
    />
  )
}

beforeEach(() => {
  mockStatus.connected = true
})

describe("ErrorDiagnosticsCard", () => {
  it("renders the title and is collapsed by default", () => {
    renderCard({ isTauri: false, appVersion: "1.2.3" })
    expect(screen.getByText("System diagnostics")).toBeInTheDocument()
    // Collapsed → rows not mounted yet.
    expect(screen.queryByTestId("error-diagnostics-row-appVersion")).toBeNull()
  })

  it("reveals diagnostic rows when expanded, resolving async fields", async () => {
    renderCard({ isTauri: true, appVersion: "9.9.9", platform: "macos", osVersion: "15.4" })
    await userEvent.click(screen.getByTestId("error-diagnostics-toggle"))

    await waitFor(() =>
      expect(screen.getByTestId("error-diagnostics-row-appVersion")).toHaveTextContent("9.9.9")
    )
    expect(screen.getByTestId("error-diagnostics-row-platform")).toHaveTextContent("macos")
    expect(screen.getByTestId("error-diagnostics-row-osVersion")).toHaveTextContent("15.4")
    expect(screen.getByTestId("error-diagnostics-row-runtime")).toHaveTextContent("Desktop")
    expect(screen.getByTestId("error-diagnostics-row-locale")).toHaveTextContent("en")
    expect(screen.getByTestId("error-diagnostics-row-route")).toHaveTextContent("/dashboard")
    expect(screen.getByTestId("error-diagnostics-row-category")).toHaveTextContent("Render error")
  })

  it("shows an offline indicator when disconnected", async () => {
    mockStatus.connected = false
    renderCard({ isTauri: false })
    await userEvent.click(screen.getByTestId("error-diagnostics-toggle"))
    expect(await screen.findByTestId("error-diagnostics-online")).toHaveTextContent("Offline")
  })

  it("falls back to em-dash when diagnostics are null", async () => {
    renderCard(null)
    await userEvent.click(screen.getByTestId("error-diagnostics-toggle"))
    expect(screen.getByTestId("error-diagnostics-row-appVersion")).toHaveTextContent("—")
    expect(screen.getByTestId("error-diagnostics-row-runtime")).toHaveTextContent("—")
  })

  it("renders Browser runtime label when not in Tauri", async () => {
    renderCard({ isTauri: false, appVersion: "1.0.0" })
    await userEvent.click(screen.getByTestId("error-diagnostics-toggle"))
    expect(screen.getByTestId("error-diagnostics-row-runtime")).toHaveTextContent("Browser")
  })

  it("tolerates a getDiagnostics rejection without throwing", async () => {
    renderCard(null, { getDiagnostics: jest.fn().mockRejectedValue(new Error("nope")) })
    await userEvent.click(screen.getByTestId("error-diagnostics-toggle"))
    expect(screen.getByTestId("error-diagnostics-row-appVersion")).toHaveTextContent("—")
  })
})
