import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}))

import type { UseHostUpdateDeps } from "@/hooks/remote-host/use-host-update"
import type { DeviceRow } from "@/lib/devices/types"
import { HostUpdateUnsupportedError, type HostUpdateStatus } from "@/lib/remote-host/host-update"

import { HostUpdatesSection } from "./host-updates-section"

const row = {
  ref: "host:mini",
  kind: "remote-host",
  label: "Mac mini",
  hostId: "mini",
} as DeviceRow

const status = (overrides: Partial<HostUpdateStatus> = {}): HostUpdateStatus => ({
  install: "native",
  currentVersion: "1.4.0",
  channel: "stable",
  autoUpdate: true,
  phase: "available",
  available: { version: "1.5.0", criticality: "routine" },
  installRequested: false,
  ...overrides,
})

function renderSection(answer: HostUpdateStatus, deps: UseHostUpdateDeps = {}) {
  const read = async () => answer
  return render(<HostUpdatesSection row={row} deps={{ read, ...deps }} />)
}

beforeEach(() => toastError.mockReset())

describe("HostUpdatesSection", () => {
  it("shows the version, the release on offer, and lets the owner update now", async () => {
    const install = jest.fn(async () =>
      status({
        installRequested: true,
        phase: "waiting-for-idle",
        waitingFor: { activeRuns: 2, jobs: 1, workerSlots: 0, mutations: 0, adminLeases: 0 },
      })
    )
    renderSection(status(), { install })
    expect(await screen.findByTestId("host-updates-version")).toHaveTextContent("1.4.0")
    expect(screen.getByTestId("host-updates-phase")).toHaveTextContent("1.5.0")
    await userEvent.click(screen.getByTestId("host-updates-install"))
    expect(install).toHaveBeenCalledWith("mini")
    // Waiting for idle names what it waits for, and offers no second install.
    expect(await screen.findByTestId("host-updates-waiting")).toHaveTextContent("2")
    expect(screen.queryByTestId("host-updates-install")).toBeNull()
  })

  it("turns automatic updates off and reports a refusal", async () => {
    const configure = jest.fn(async () => {
      throw new Error("an update is being verified")
    })
    renderSection(status(), { configure })
    await userEvent.click(await screen.findByTestId("host-updates-auto"))
    expect(configure).toHaveBeenCalledWith("mini", { autoUpdate: false })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(String(toastError.mock.calls[0][0])).toContain("an update is being verified")
  })

  it("says why a host cannot update itself, and offers no update", async () => {
    renderSection(status({ install: "unmanaged", unmanagedReason: "not-installed" }))
    expect(await screen.findByTestId("host-updates-unmanaged")).toHaveAttribute(
      "data-reason",
      "not-installed"
    )
    expect(screen.queryByTestId("host-updates-install")).toBeNull()
    expect(screen.getByTestId("host-updates-auto")).toBeDisabled()
  })

  it("reports how the last update ended and a failed check", async () => {
    renderSection(
      status({
        phase: "idle",
        available: undefined,
        lastError: "no catalog is published for the beta channel",
        lastOutcome: {
          attemptId: "a",
          from: "1.4.0",
          to: "1.5.0",
          result: "rolled-back",
          reason: "its server refused its brain",
          atMs: Date.now() - 60_000,
        },
      })
    )
    expect(await screen.findByTestId("host-updates-outcome")).toHaveTextContent(
      "its server refused its brain"
    )
    expect(screen.getByTestId("host-updates-error")).toHaveTextContent("no catalog")
  })

  it("names a host from before self-update", async () => {
    const tooOld = async (): Promise<HostUpdateStatus> => {
      throw new HostUpdateUnsupportedError()
    }
    render(<HostUpdatesSection row={row} deps={{ read: tooOld }} />)
    expect(await screen.findByTestId("host-updates-unsupported")).toBeInTheDocument()
  })
})
