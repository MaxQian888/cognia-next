import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { PairedDeviceLifecycle, PairedDeviceLifecycleNotice } from "./paired-device-lifecycle"

// eslint-disable-next-line no-var -- jest.mock factories hoist above this body.
var hostProfile: string
jest.mock("@/hooks/use-host-profile", () => ({
  ...jest.requireActual("@/hooks/use-host-profile"),
  useHostProfile: () => hostProfile,
}))

beforeEach(() => {
  hostProfile = "desktop"
})

function actions(): DeviceGrantActions {
  return {
    toggleRemoteControl: jest.fn(async () => {}),
    toggleAgentControl: jest.fn(async () => {}),
    toggleRemoteTerminal: jest.fn(async () => {}),
    toggleSshFiles: jest.fn(async () => {}),
    toggleLockedComputerUse: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    revoke: jest.fn(async () => {}),
  }
}

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:d1",
    kind: "paired-device",
    label: "Phone",
    isSelf: false,
    deviceId: "d1",
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

describe("PairedDeviceLifecycle", () => {
  it("offers pause for an active device and resume for a paused one", async () => {
    const handlers = actions()
    const { rerender } = render(<PairedDeviceLifecycle row={row()} actions={handlers} />)
    await userEvent.click(screen.getByTestId("paired-device-pause-d1"))
    expect(handlers.pause).toHaveBeenCalledWith("d1", "Phone")
    expect(screen.queryByTestId("paired-device-resume-d1")).not.toBeInTheDocument()

    rerender(<PairedDeviceLifecycle row={row({ adminState: "paused" })} actions={handlers} />)
    await userEvent.click(screen.getByTestId("paired-device-resume-d1"))
    expect(handlers.resume).toHaveBeenCalledWith("d1", "Phone")
    expect(screen.queryByTestId("paired-device-pause-d1")).not.toBeInTheDocument()
  })

  /**
   * Revocation cannot be undone from here, and the biometric prompt that
   * used to be its only gate can be switched off in Settings → Security.
   */
  it("asks before revoking, and revokes nothing when the answer is no", async () => {
    const handlers = actions()
    render(<PairedDeviceLifecycle row={row()} actions={handlers} />)

    await userEvent.click(screen.getByTestId("paired-device-revoke-d1"))
    expect(screen.getByText("Revoke Phone?")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(handlers.revoke).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId("paired-device-revoke-d1"))
    await userEvent.click(screen.getByTestId("paired-device-revoke-confirm-d1"))
    expect(handlers.revoke).toHaveBeenCalledWith("d1", "Phone")
  })

  it("offers nothing on a device that is already revoked", () => {
    render(<PairedDeviceLifecycle row={row({ adminState: "revoked" })} actions={actions()} />)
    expect(screen.queryByTestId("paired-device-pause-d1")).not.toBeInTheDocument()
    expect(screen.queryByTestId("paired-device-revoke-d1")).not.toBeInTheDocument()
  })

  it("renders nothing for a kind that has no lifecycle here", () => {
    const { container } = render(
      <PairedDeviceLifecycle row={row({ kind: "remote-host" })} actions={actions()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  /**
   * ADR-0170 batch 4: every Host mounts owner routes for these, so a paired
   * companion reaches them over HTTP. Only a browser with no Host cannot.
   */
  it("keeps the controls live for a paired companion", () => {
    hostProfile = "mobile-companion"
    render(<PairedDeviceLifecycle row={row()} actions={actions()} />)
    expect(screen.getByTestId("paired-device-pause-d1")).toBeEnabled()
    expect(screen.getByTestId("paired-device-revoke-d1")).toBeEnabled()
  })

  it("disables them for a browser with no Host", () => {
    hostProfile = "web-standalone"
    render(<PairedDeviceLifecycle row={row()} actions={actions()} />)
    expect(screen.getByTestId("paired-device-pause-d1")).toBeDisabled()
    expect(screen.getByTestId("paired-device-revoke-d1")).toBeDisabled()
  })
})

describe("PairedDeviceLifecycleNotice", () => {
  /** A disabled button with nothing beside it is the shape rule 7 rules out. */
  it("says why the controls are disabled", () => {
    hostProfile = "web-standalone"
    render(<PairedDeviceLifecycleNotice row={row()} />)
    const notice = screen.getByTestId("paired-device-lifecycle-blocked")
    expect(notice).toHaveAttribute("data-reach", "no-host")
    expect(notice).toHaveTextContent(/nowhere to go/)
  })

  it("says nothing where the controls work", () => {
    const { container } = render(<PairedDeviceLifecycleNotice row={row()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says nothing for a revoked device, which has no controls to explain", () => {
    hostProfile = "web-standalone"
    const { container } = render(
      <PairedDeviceLifecycleNotice row={row({ adminState: "revoked" })} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
