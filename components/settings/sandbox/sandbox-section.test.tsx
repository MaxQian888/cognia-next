// ADR-0028 Phase 7 — SandboxSection unit tests.

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { SandboxSection } from "./sandbox-section"

// `isTauri` was missing from this stub, so the suite could not load at all once
// anything in the import chain reached `createKeyringStore`. Pre-existing on
// dev, not caused by the card that used to be mocked out below.
jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
  isTauri: () => false,
}))

// The enable + tier cards have their own tests and depend on the settings
// store; stub them so this suite stays focused on the health card + IPC.
jest.mock("./sandbox-enable-card", () => ({
  SandboxEnableCard: () => <div data-testid="sandbox-enable-card-stub" />,
}))
jest.mock("./canvas-code-sandbox-card", () => ({
  CanvasCodeSandboxCard: () => <div data-testid="canvas-code-sandbox-card-stub" />,
}))
jest.mock("./sandbox-tier-card", () => ({
  SandboxTierCard: () => <div data-testid="sandbox-tier-card-stub" />,
}))
jest.mock("./sandbox-policy-card", () => ({
  SandboxPolicyCard: () => <div data-testid="sandbox-policy-card-stub" />,
}))

import { transport } from "@/lib/tauri"

const mockCall = transport.call as jest.MockedFunction<typeof transport.call>

const MESSAGES = {
  settings: {
    sandbox: {
      title: "Sandbox",
      description: "Per-platform OS sandbox.",
      retryButton: "Run health probe",
      verifyButton: "Verify confinement",
      strictModeNote: "When unavailable, Bash/Edit/Write are refused.",
      backend: { label: "Backend" },
      version: { label: "Version" },
      lastError: { label: "Last error" },
      ipcError: { label: "IPC error" },
      status: {
        ok: "Active",
        setup: "Setup required",
        down: "Unavailable",
      },
      probe: {
        running: "Verifying…",
        ok: "Confinement verified",
        failed: "Confinement check failed",
        label: "Probe",
      },
    },
  },
}

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockCall.mockReset()
})

describe("SandboxSection", () => {
  it("renders 'Setup required' when health.available is false", async () => {
    mockCall.mockResolvedValue({
      available: false,
      backend: "windows-codex-vendor-pending",
      version: "",
      last_error: "vendoring pending",
    })
    renderWithIntl(<SandboxSection />)
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-status-badge")).toHaveTextContent("Setup required")
    })
    expect(await screen.findByText("windows-codex-vendor-pending")).toBeInTheDocument()
    expect(await screen.findByText("vendoring pending")).toBeInTheDocument()
  })

  it("renders 'Active' when health.available is true", async () => {
    mockCall.mockResolvedValue({
      available: true,
      backend: "linux-bwrap",
      version: "system",
      last_error: "",
    })
    renderWithIntl(<SandboxSection />)
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-status-badge")).toHaveTextContent("Active")
    })
    expect(screen.getByText("linux-bwrap")).toBeInTheDocument()
  })

  it("renders 'Unavailable' when IPC errors", async () => {
    mockCall.mockRejectedValue(new Error("ipc down"))
    renderWithIntl(<SandboxSection />)
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-status-badge")).toHaveTextContent("Unavailable")
    })
    expect(screen.getByText("ipc down")).toBeInTheDocument()
  })

  it("refreshes health when the retry button is clicked", async () => {
    mockCall.mockResolvedValue({
      available: false,
      backend: "uninstalled-bsd",
      version: "",
      last_error: "no backend bundled",
    })
    renderWithIntl(<SandboxSection />)
    await waitFor(() => expect(mockCall).toHaveBeenCalled())
    const callsBefore = mockCall.mock.calls.length

    mockCall.mockResolvedValueOnce({
      available: true,
      backend: "macos-sandbox-exec",
      version: "system",
      last_error: "",
    })
    await userEvent.click(screen.getByTestId("sandbox-retry-button"))
    await waitFor(() => expect(mockCall.mock.calls.length).toBeGreaterThan(callsBefore))
    await waitFor(() => {
      expect(screen.getByText("macos-sandbox-exec")).toBeInTheDocument()
    })
  })

  it("runs the active confinement probe and shows the verified result", async () => {
    mockCall.mockImplementation(async (cmd: string) => {
      if (cmd === "sandbox_health_check") {
        return { backend: "macos-sandbox-exec", confined: true, detail: "ok" }
      }
      return { available: true, backend: "macos-sandbox-exec", version: "system", last_error: "" }
    })
    renderWithIntl(<SandboxSection />)
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-status-badge")).toHaveTextContent("Active")
    })
    await userEvent.click(screen.getByTestId("sandbox-verify-button"))
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-probe-result")).toHaveTextContent("Confinement verified")
    })
  })

  it("surfaces a failed confinement probe with its detail", async () => {
    mockCall.mockImplementation(async (cmd: string) => {
      if (cmd === "sandbox_health_check") {
        return { backend: "linux-bwrap", confined: false, detail: "write not blocked" }
      }
      return { available: true, backend: "linux-bwrap", version: "system", last_error: "" }
    })
    renderWithIntl(<SandboxSection />)
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-status-badge")).toHaveTextContent("Active")
    })
    await userEvent.click(screen.getByTestId("sandbox-verify-button"))
    await waitFor(() => {
      const result = screen.getByTestId("sandbox-probe-result")
      expect(result).toHaveTextContent("Confinement check failed")
      expect(result).toHaveTextContent("write not blocked")
    })
  })

  it("hides the strict-mode note when the sandbox is healthy", async () => {
    mockCall.mockResolvedValue({
      available: true,
      backend: "macos-sandbox-exec",
      version: "system",
      last_error: "",
    })
    renderWithIntl(<SandboxSection />)
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-status-badge")).toHaveTextContent("Active")
    })
    expect(screen.queryByText(MESSAGES.settings.sandbox.strictModeNote)).not.toBeInTheDocument()
  })
})
