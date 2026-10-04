import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { HostConnectionState, HostControls } from "./host-controls"

let anyActive = false
jest.mock("@/lib/devices/execution-host-guard", () => ({
  anyRunActive: () => Promise.resolve(anyActive),
}))

// The real store with its actions stubbed, so the controls run through the
// real `useExecutionHostSwitch` (and its in-flight guard) without installing a
// transport.
const initialStore = useRemoteHostStore.getState()
const activateHost = jest.fn()
const deactivate = jest.fn()
const removeHost = jest.fn()
const updateHostLabel = jest.fn()
const storedHost = {
  id: "h1",
  label: "Build box",
  credentialRef: "ref",
  addedAt: 1,
  connectionState: "ready",
  config: { baseUrl: "https://build.example:27890", serverVersion: "1.0.0" },
} as RemoteHost

function seedStore(activeHostId: string | null) {
  useRemoteHostStore.setState(
    {
      ...initialStore,
      hosts: [storedHost],
      activeHostId,
      activateHost,
      deactivate,
      removeHost,
      updateHostLabel,
    },
    true
  )
}

afterAll(() => useRemoteHostStore.setState(initialStore, true))

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

beforeEach(() => {
  jest.clearAllMocks()
  anyActive = false
  seedStore(null)
})

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

    act(() => seedStore("h1"))
    rerender(<HostControls row={row({ runtime: { ...row().runtime, isRoutingTarget: true } })} />)
    await userEvent.click(screen.getByTestId("host-disconnect"))
    expect(deactivate).toHaveBeenCalled()
  })

  /**
   * Connect repoints every execution call. Under a running turn that strands
   * the turn, so the masthead asks first, the same as the status-bar switcher.
   */
  it("asks before connecting while a turn is in flight", async () => {
    anyActive = true
    render(<HostControls row={row()} />)
    await userEvent.click(screen.getByTestId("host-connect"))
    expect(activateHost).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByTestId("execution-host-confirm"))
    expect(activateHost).toHaveBeenCalledWith("h1")
  })

  it("asks before disconnecting while a turn is in flight", async () => {
    anyActive = true
    seedStore("h1")
    render(<HostControls row={row({ runtime: { ...row().runtime, isRoutingTarget: true } })} />)
    await userEvent.click(screen.getByTestId("host-disconnect"))
    expect(deactivate).not.toHaveBeenCalled()
    expect(await screen.findByTestId("execution-host-confirm")).toBeInTheDocument()
  })

  /**
   * Rename is a menu item that hands the title over to the masthead, where
   * the rename field lives (`device-hero.test.tsx` covers the field).
   */
  it("hands renaming to the masthead from the overflow menu", async () => {
    const user = userEvent.setup()
    const onRename = jest.fn()
    render(<HostControls row={row()} onRename={onRename} />)
    await user.click(screen.getByTestId("host-more"))
    await user.click(screen.getByTestId("host-rename"))
    expect(onRename).toHaveBeenCalled()
    expect(updateHostLabel).not.toHaveBeenCalled()
  })

  it("offers no rename where the masthead cannot take one", async () => {
    const user = userEvent.setup()
    render(<HostControls row={row()} />)
    await user.click(screen.getByTestId("host-more"))
    expect(screen.queryByTestId("host-rename")).not.toBeInTheDocument()
    expect(screen.getByTestId("host-remove")).toBeInTheDocument()
  })

  it("confirms before forgetting a host and its stored credential", async () => {
    const user = userEvent.setup()
    render(<HostControls row={row()} />)
    await user.click(screen.getByTestId("host-more"))
    await user.click(screen.getByTestId("host-remove"))
    expect(screen.getByText("Remove this host?")).toBeInTheDocument()
    expect(removeHost).not.toHaveBeenCalled()

    await user.click(screen.getByTestId("host-remove-confirm"))
    expect(removeHost).toHaveBeenCalledWith("h1")
  })

  /**
   * Removing the active host deactivates it first, so the in-flight warning
   * rides in the same confirmation rather than being skipped.
   */
  it("warns about the running turn when removing the host being driven", async () => {
    anyActive = true
    seedStore("h1")
    const user = userEvent.setup()
    render(<HostControls row={row({ runtime: { ...row().runtime, isRoutingTarget: true } })} />)
    await user.click(screen.getByTestId("host-more"))
    await user.click(screen.getByTestId("host-remove"))
    expect(await screen.findByTestId("execution-host-remove-active")).toBeInTheDocument()
    expect(removeHost).not.toHaveBeenCalled()
  })
})

/**
 * `connectionState` has carried `degraded`, `versionMismatch` and `revoked`
 * since ADR-0082, and `connectionError` has carried the reason. The header
 * counted them and this card rendered neither, so a host stuck mid-handshake
 * looked exactly like one nobody had connected yet.
 */
describe("connection health", () => {
  /**
   * The verbatim error is the dashboard's connection alert now
   * (`device-detail.test.tsx`); the masthead line names the state only, so
   * one sentence is not on screen twice.
   */
  it("names the state, and leaves the verbatim error to the dashboard", () => {
    render(
      <HostConnectionState
        row={row({ connectionState: "degraded", connectionError: "capability probe timed out" })}
      />
    )
    expect(screen.getByTestId("host-connection-state")).toHaveAttribute("data-state", "degraded")
    expect(screen.getByText("Degraded")).toBeInTheDocument()
    expect(screen.queryByText("capability probe timed out")).not.toBeInTheDocument()
  })

  it("says nothing for a kind with no handshake", () => {
    const { container } = render(<HostConnectionState row={row({ kind: "worker" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("offers a reconnect on a connected host, because connected can still be degraded", async () => {
    seedStore("h1")
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
      <HostConnectionState
        row={row({ connectionState: "versionMismatch", serverVersion: "0.9.1" })}
      />
    )
    expect(screen.getByTestId("host-version-mismatch")).toHaveTextContent("0.9.1")
  })
})

it("routes Companion management to pairing without offering store-only actions", () => {
  render(
    <HostControls
      row={row({
        ref: "companion:paired-host",
        hostId: undefined,
        connectionState: "degraded",
        connectionError: "connection lost",
      })}
    />
  )
  expect(screen.getByRole("link", { name: "Manage paired Host" })).toHaveAttribute("href", "/pair")
  expect(screen.queryByTestId("host-connect")).not.toBeInTheDocument()
  expect(screen.queryByTestId("host-more")).not.toBeInTheDocument()
})
