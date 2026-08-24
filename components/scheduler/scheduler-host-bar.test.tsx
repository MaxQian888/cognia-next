/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

const hostTarget = {
  target: "local" as "local" | "paired",
  pairedAvailable: false,
  setTarget: jest.fn(),
}
jest.mock("@/hooks/scheduler/use-scheduler-host-target", () => ({
  useSchedulerHostTarget: () => hostTarget,
}))
const profileState = { value: "desktop" as string }
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => profileState.value }))
const routing = { active: false }
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: () => routing.active }))
interface RemoteHostRow {
  id: string
  label?: string
  config: { baseUrl: string }
}
const remoteState = {
  hosts: [] as RemoteHostRow[],
  activeHostId: null as string | null,
}
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (s: typeof remoteState) => unknown) => selector(remoteState),
}))

import { SchedulerHostBar } from "./scheduler-host-bar"

beforeEach(() => {
  hostTarget.target = "local"
  hostTarget.pairedAvailable = false
  hostTarget.setTarget.mockClear()
  profileState.value = "desktop"
  routing.active = false
  remoteState.hosts = []
  remoteState.activeHostId = null
})

describe("SchedulerHostBar", () => {
  it("states that tasks run on this device when no paired host exists", () => {
    render(<SchedulerHostBar />)
    expect(screen.getByTestId("scheduler-host-bar")).toHaveTextContent(/this device/i)
    expect(screen.getByTestId("scheduler-host-bar-no-paired")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-host-bar-switch")).not.toBeInTheDocument()
    // Nobody to hand execution authority to on a single-machine install.
    expect(screen.queryByTestId("scheduler-authority-control")).not.toBeInTheDocument()
  })

  it("on a desktop driving a remote host: names the host, marks local as suspended, and switches", () => {
    routing.active = true
    hostTarget.pairedAvailable = true
    hostTarget.target = "paired"
    remoteState.hosts = [{ id: "h1", label: "Office box", config: { baseUrl: "https://x" } }]
    remoteState.activeHostId = "h1"
    const { rerender } = render(<SchedulerHostBar />)
    expect(screen.getByTestId("scheduler-host-bar")).toHaveTextContent(/Office box/)
    // The execution-authority control lives on this bar, not in its own card.
    expect(screen.getByTestId("scheduler-authority-control")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("scheduler-host-bar-switch"))
    expect(hostTarget.setTarget).toHaveBeenCalledWith("local")
    hostTarget.target = "local"
    rerender(<SchedulerHostBar />)
    expect(screen.getByTestId("scheduler-host-bar-suspended")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-host-bar-local-note")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("scheduler-host-bar-switch"))
    expect(hostTarget.setTarget).toHaveBeenLastCalledWith("paired")
  })

  it("on a companion viewing this device: warns the local schedule only runs while open", () => {
    profileState.value = "mobile-companion"
    hostTarget.pairedAvailable = true
    hostTarget.target = "local"
    render(<SchedulerHostBar />)
    expect(screen.getByTestId("scheduler-host-bar-local-note")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-host-bar-switch")).toHaveTextContent(/paired desktop/i)
  })

  it("on a cloud companion managing the paired host: labels it as the cloud host", () => {
    profileState.value = "cloud-companion"
    hostTarget.pairedAvailable = true
    hostTarget.target = "paired"
    render(<SchedulerHostBar />)
    expect(screen.getByTestId("scheduler-host-bar")).toHaveTextContent(/cloud host/i)
    expect(screen.getByTestId("scheduler-host-bar-switch")).toHaveTextContent(/this device/i)
  })

  it("falls back to the base URL when the remote host has no label", () => {
    routing.active = true
    hostTarget.pairedAvailable = true
    hostTarget.target = "paired"
    remoteState.hosts = [{ id: "h1", config: { baseUrl: "https://srv.example" } }]
    remoteState.activeHostId = "h1"
    render(<SchedulerHostBar />)
    expect(screen.getByTestId("scheduler-host-bar")).toHaveTextContent(/srv\.example/)
  })
})
