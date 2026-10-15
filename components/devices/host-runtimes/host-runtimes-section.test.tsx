import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

import type { UseHostRuntimesDeps } from "@/hooks/remote-host/use-host-runtimes"
import type { DeviceRow } from "@/lib/devices/types"
import {
  HostRuntimesUnavailableError,
  type HostRuntime,
  type HostRuntimes,
} from "@/lib/remote-host/host-runtimes"

import { HostRuntimesSection, orderRuntimes } from "./host-runtimes-section"

const row = {
  ref: "host:cloud",
  kind: "remote-host",
  label: "Cloud host",
  hostId: "cloud",
} as DeviceRow

const runtime = (name: string, overrides: Partial<HostRuntime> = {}): HostRuntime => ({
  name,
  state: "running",
  restartable: true,
  restarts: 0,
  ...overrides,
})

const bots = runtime("bots")
const roomRunner = runtime("room-runner", {
  state: "failed",
  error: "no backend",
  restarts: 0,
})
const initializers = runtime("initializers", { restartable: false })

function renderSection(runtimes: HostRuntime[], deps: UseHostRuntimesDeps = {}) {
  const read = async (): Promise<HostRuntimes> => ({ runtimes })
  return render(<HostRuntimesSection row={row} deps={{ read, ...deps }} />)
}

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
})

describe("HostRuntimesSection", () => {
  it("leads with the runtimes that failed and says how many", async () => {
    renderSection([bots, initializers, roomRunner])
    expect(await screen.findByTestId("host-runtimes-summary")).toHaveTextContent(
      "1 of 3 runtimes failed to start"
    )
    const items = within(screen.getByTestId("host-runtimes-list")).getAllByRole("listitem")
    expect(items.map((item) => item.getAttribute("data-testid"))).toEqual([
      "host-runtime-room-runner",
      "host-runtime-bots",
      "host-runtime-initializers",
    ])
    expect(screen.getByTestId("host-runtime-room-runner")).toHaveTextContent("no backend")
    // Running with no teardown: shown, labelled, and not restartable.
    expect(screen.getByTestId("host-runtime-initializers")).toHaveTextContent(
      "only restarting the host restarts it"
    )
    expect(screen.getByTestId("host-runtime-restart-initializers")).toBeDisabled()
  })

  it("restarts a failed runtime directly and shows it running", async () => {
    const after = runtime("room-runner", { restarts: 1, startedAt: Date.now() })
    const restart = jest.fn(async () => ({ runtime: after, runtimes: [bots, after] }))
    renderSection([bots, roomRunner], { restart })
    await userEvent.click(await screen.findByTestId("host-runtime-restart-room-runner"))
    expect(restart).toHaveBeenCalledWith("cloud", "room-runner")
    await waitFor(() =>
      expect(screen.getByTestId("host-runtimes-summary")).toHaveTextContent(
        "All 2 runtimes are running"
      )
    )
    expect(toastSuccess).toHaveBeenCalledWith("room-runner restarted")
    expect(screen.getByTestId("host-runtime-room-runner")).toHaveTextContent("Restarted once")
  })

  it("asks before restarting a running runtime", async () => {
    const restart = jest.fn(async () => ({ runtime: bots, runtimes: [bots] }))
    renderSection([bots], { restart })
    await userEvent.click(await screen.findByTestId("host-runtime-restart-bots"))
    expect(restart).not.toHaveBeenCalled()
    expect(await screen.findByText("Restart bots?")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("host-runtime-restart-confirm"))
    await waitFor(() => expect(restart).toHaveBeenCalledWith("cloud", "bots"))
  })

  it("reports a runtime that did not start again, and a refusal", async () => {
    const stillFailed = runtime("room-runner", {
      state: "failed",
      error: "still no backend",
      restarts: 1,
    })
    const restart = jest
      .fn()
      .mockResolvedValueOnce({ runtime: stillFailed, runtimes: [stillFailed] })
      .mockRejectedValueOnce(new Error("brain disconnected"))
    renderSection([roomRunner], { restart })
    await userEvent.click(await screen.findByTestId("host-runtime-restart-room-runner"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("room-runner did not start again: still no backend")
    )
    await userEvent.click(screen.getByTestId("host-runtime-restart-room-runner"))
    await waitFor(() =>
      expect(toastError).toHaveBeenLastCalledWith(
        "Could not restart room-runner: brain disconnected"
      )
    )
  })

  it("says why a desktop host or an old host shows no runtimes", async () => {
    const desktop = async (): Promise<HostRuntimes> => {
      throw new HostRuntimesUnavailableError("not-headless")
    }
    render(<HostRuntimesSection row={row} deps={{ read: desktop }} />)
    expect(await screen.findByTestId("host-runtimes-unavailable")).toHaveAttribute(
      "data-reason",
      "not-headless"
    )
    expect(screen.getByTestId("host-runtimes-refresh")).toBeDisabled()
  })

  it("orders failed, then restarting, then running, keeping the host's order", () => {
    const restarting = runtime("sync", { state: "restarting", restartable: false })
    expect(
      orderRuntimes([bots, restarting, roomRunner, initializers]).map((entry) => entry.name)
    ).toEqual(["room-runner", "sync", "bots", "initializers"])
  })
})
