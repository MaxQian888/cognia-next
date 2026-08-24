import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"

import { HostControls } from "./host-controls"

const activateHost = jest.fn()
const deactivate = jest.fn()
const removeHost = jest.fn()
const updateHostLabel = jest.fn()

jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (state: unknown) => unknown) =>
    selector({ activateHost, deactivate, removeHost, updateHostLabel }),
}))

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "host:h1",
    kind: "remote-host",
    label: "Build box",
    isSelf: false,
    hostId: "h1",
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "manifest" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "requires-activation" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

beforeEach(() => jest.clearAllMocks())

describe("HostControls", () => {
  it("renders nothing for a device that is not a remote host", () => {
    const { container } = render(<HostControls row={row({ kind: "paired-device" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing for a host row with no store id to act on", () => {
    const { container } = render(<HostControls row={row({ hostId: undefined })} />)
    expect(container).toBeEmptyDOMElement()
  })

  /**
   * Connecting is what makes a host the transport's execution target, which is
   * why the Runtime tab's workspace list becomes readable only once it is
   * active — the same store call backs both.
   */
  it("offers connect while another host is driving, and disconnect once it is", async () => {
    const { rerender } = render(<HostControls row={row()} />)
    await userEvent.click(screen.getByTestId("host-connect"))
    expect(activateHost).toHaveBeenCalledWith("h1")

    rerender(<HostControls row={row({ runtime: { ...row().runtime, isRoutingTarget: true } })} />)
    await userEvent.click(screen.getByTestId("host-disconnect"))
    expect(deactivate).toHaveBeenCalled()
  })

  it("renames inline and commits the trimmed label", async () => {
    render(<HostControls row={row()} />)
    await userEvent.click(screen.getByTestId("host-rename"))
    const input = screen.getByTestId("host-rename-input")
    await userEvent.clear(input)
    await userEvent.type(input, "  CI box  ")
    await userEvent.click(screen.getByTestId("host-rename-save"))
    expect(updateHostLabel).toHaveBeenCalledWith("h1", "CI box")
  })

  /**
   * An empty label leaves a row that cannot be told apart from any other
   * unnamed host, so it is simply not a rename.
   */
  it("refuses to save an empty label", async () => {
    render(<HostControls row={row()} />)
    await userEvent.click(screen.getByTestId("host-rename"))
    await userEvent.clear(screen.getByTestId("host-rename-input"))
    expect(screen.getByTestId("host-rename-save")).toBeDisabled()
  })

  it("abandons a rename without writing anything", async () => {
    render(<HostControls row={row()} />)
    await userEvent.click(screen.getByTestId("host-rename"))
    await userEvent.type(screen.getByTestId("host-rename-input"), "x")
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(updateHostLabel).not.toHaveBeenCalled()
    expect(screen.getByTestId("host-rename")).toBeInTheDocument()
  })

  it("confirms before forgetting a host and its stored credential", async () => {
    render(<HostControls row={row()} />)
    await userEvent.click(screen.getByTestId("host-remove"))
    expect(screen.getByText("Remove this host?")).toBeInTheDocument()
    expect(removeHost).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId("host-remove-confirm"))
    expect(removeHost).toHaveBeenCalledWith("h1")
  })
})
