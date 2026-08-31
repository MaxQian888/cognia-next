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

/**
 * `connectionState` has carried `degraded`, `versionMismatch` and `revoked`
 * since ADR-0082, and `connectionError` has carried the reason. The header
 * counted them and this card rendered neither, so a host stuck mid-handshake
 * looked exactly like one nobody had connected yet.
 */
describe("connection health", () => {
  it("names the state and the reason verbatim", () => {
    render(
      <HostControls
        row={row({ connectionState: "degraded", connectionError: "capability probe timed out" })}
      />
    )
    expect(screen.getByTestId("host-connection-state")).toHaveAttribute("data-state", "degraded")
    expect(screen.getByTestId("host-connection-error")).toHaveTextContent(
      "capability probe timed out"
    )
  })

  it("offers a reconnect on a connected host, because connected can still be degraded", async () => {
    render(
      <HostControls
        row={row({
          connectionState: "degraded",
          runtime: {
            sandbox: { support: "unsupported", connections: [] },
            shellTiers: [],
            workspaces: { support: "supported" },
            isRoutingTarget: true,
          },
        })}
      />
    )
    await userEvent.click(screen.getByTestId("host-reconnect"))
    expect(activateHost).toHaveBeenCalledWith("h1")
  })

  /**
   * A host that threw this device out cannot be reconnected, only paired
   * again. Offering Connect there sends the user round a loop.
   */
  it("replaces connect with re-pair on a revoked host", () => {
    const onRepair = jest.fn()
    render(<HostControls row={row({ connectionState: "revoked" })} onRepair={onRepair} />)
    expect(screen.queryByTestId("host-connect")).not.toBeInTheDocument()
    expect(screen.getByTestId("host-repair")).toBeInTheDocument()
  })

  it("shows the host's version when it is the thing to upgrade", () => {
    render(
      <HostControls row={row({ connectionState: "versionMismatch", serverVersion: "0.9.1" })} />
    )
    expect(screen.getByTestId("host-version-mismatch")).toHaveTextContent("0.9.1")
  })
})
