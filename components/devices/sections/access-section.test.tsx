import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { buildGrantRows } from "@/lib/devices/grant-capabilities"
import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { AccessSection } from "./access-section"

/**
 * The terminal grant now asks `useSurfaceReach` rather than `isTauri()`,
 * because a switch that writes only the Dexie mirror off the desktop reports a
 * grant the host never made. The suite drives that resolver directly, so the
 * desktop and companion cases are both reachable here.
 */
// eslint-disable-next-line no-var -- jest.mock factories hoist above this body.
var hostProfile: string
// eslint-disable-next-line no-var -- same hoisting rule.
var capabilityHeld: boolean
jest.mock("@/hooks/use-host-profile", () => ({
  ...jest.requireActual("@/hooks/use-host-profile"),
  useHostProfile: () => hostProfile,
  useCapability: () => capabilityHeld,
}))

beforeEach(() => {
  hostProfile = "desktop"
  capabilityHeld = true
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
    pubkey: "pk",
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: buildGrantRows({
      mirror: { control: false, agentControl: false, terminal: false, lockedComputerUse: false },
      revoked: false,
    }),
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

describe("AccessSection — grants", () => {
  it("keeps the paired-devices card's test ids so its coverage ports across", () => {
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.getByTestId("paired-device-remote-control-d1")).toBeInTheDocument()
    expect(screen.getByTestId("paired-device-agent-control-d1")).toBeInTheDocument()
    expect(screen.getByTestId("paired-device-remote-terminal-d1")).toBeInTheDocument()
    expect(screen.getByTestId("paired-device-locked-computer-use-d1")).toBeInTheDocument()
  })

  /**
   * The whole reason this console exists: `companion_list_device_grants` uses
   * an all-of test, so a half-held grant used to render identically to one
   * that had never been granted.
   */
  it("shows a partial grant as partial, with the missing capabilities struck through", () => {
    const grants = buildGrantRows({
      hostCapabilities: ["agent.run", "workspace.read"],
      mirror: { control: false, agentControl: false, terminal: false, lockedComputerUse: false },
      revoked: false,
    })
    render(<AccessSection row={row({ grants })} actions={actions()} />)
    const section = screen.getByTestId("grant-control")
    expect(within(section).getByText("Partial")).toBeInTheDocument()
    expect(within(section).getByText("agent.run").className).toContain("emerald")
    expect(within(section).getByText("workspace.write").className).toContain("line-through")
    expect(screen.getByText(/only some of the capabilities/)).toBeInTheDocument()
  })

  it("says when a grant is only known from the local mirror", () => {
    const grants = buildGrantRows({
      mirror: {
        control: true,
        agentControl: false,
        terminal: false,
        sshFiles: false,
        lockedComputerUse: false,
      },
      revoked: false,
    })
    render(<AccessSection row={row({ grants })} actions={actions()} />)
    // Every real grant falls back the same way when the host is unreachable.
    // Derived rather than a literal, so a grant added without a fallback line
    // fails here instead of quietly rendering one row that explains nothing.
    const realGrants = grants.filter((grant) => grant.id !== "lockedComputerUse")
    expect(
      screen.getAllByText("From the local mirror — this host could not be asked.")
    ).toHaveLength(realGrants.length)
  })

  /**
   * ADR-0162 states the reach in three places, and this is the one a person
   * actually reads before flipping the switch. Losing it would leave the
   * console implying a confinement the wire cannot enforce.
   */
  it("says that SSH file transfer has no folder limit", async () => {
    const handlers = actions()
    render(<AccessSection row={row()} actions={handlers} />)
    expect(screen.getByTestId("grant-ssh-files-note")).toHaveTextContent(/no folder limit/i)
    await userEvent.click(screen.getByTestId("paired-device-ssh-files-d1"))
    expect(handlers.toggleSshFiles).toHaveBeenCalledWith("d1", "Phone", true)
  })

  it("routes each switch to its own action", async () => {
    const handlers = actions()
    render(<AccessSection row={row()} actions={handlers} />)
    await userEvent.click(screen.getByTestId("paired-device-remote-control-d1"))
    expect(handlers.toggleRemoteControl).toHaveBeenCalledWith("d1", "Phone", true)
    await userEvent.click(screen.getByTestId("paired-device-agent-control-d1"))
    expect(handlers.toggleAgentControl).toHaveBeenCalledWith("d1", "Phone", true)
  })

  it("passes the pubkey the terminal grant needs to provision a descriptor", async () => {
    const handlers = actions()
    render(<AccessSection row={row()} actions={handlers} />)
    await userEvent.click(screen.getByTestId("paired-device-remote-terminal-d1"))
    expect(handlers.toggleRemoteTerminal).toHaveBeenCalledWith("d1", "pk", "Phone", true)
  })
})

describe("AccessSection — Locked Use dormancy", () => {
  /**
   * UI axis of the three-axis dormancy contract (CLAUDE.md working rule 7):
   * the switch renders, labelled, rather than implying a permission is being
   * handed out.
   */
  it("renders the switch inert and labelled", () => {
    render(<AccessSection row={row()} actions={actions()} />)
    const toggle = screen.getByTestId("paired-device-locked-computer-use-d1")
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute("data-state", "unchecked")
    const section = screen.getByTestId("grant-lockedComputerUse")
    expect(within(section).getByText("Not available in this build")).toBeInTheDocument()
    expect(within(section).getByText(/no enforcement point on this build/)).toBeInTheDocument()
  })
})

describe("AccessSection — lifecycle", () => {
  it("offers pause for an active device and resume for a paused one", async () => {
    const handlers = actions()
    const { rerender } = render(<AccessSection row={row()} actions={handlers} />)
    expect(screen.getByTestId("paired-device-pause-d1")).toBeInTheDocument()
    expect(screen.queryByTestId("paired-device-resume-d1")).not.toBeInTheDocument()

    rerender(<AccessSection row={row({ adminState: "paused" })} actions={handlers} />)
    await userEvent.click(screen.getByTestId("paired-device-resume-d1"))
    expect(handlers.resume).toHaveBeenCalledWith("d1", "Phone")
  })

  it("disables every control on a revoked device and says why", () => {
    const grants = buildGrantRows({
      revoked: true,
      hostCapabilities: ["agent.run"],
      mirror: { control: true, agentControl: true, terminal: true, lockedComputerUse: true },
    })
    render(<AccessSection row={row({ adminState: "revoked", grants })} actions={actions()} />)
    expect(screen.getByText("This device is revoked")).toBeInTheDocument()
    expect(screen.getByTestId("paired-device-remote-control-d1")).toBeDisabled()
    expect(screen.getByTestId("paired-device-revoke-d1")).toBeDisabled()
    expect(screen.queryByTestId("paired-device-pause-d1")).not.toBeInTheDocument()
  })
})

describe("AccessSection — devices with no grants", () => {
  it.each(["local", "remote-host", "worker"] as const)("explains why %s has none", (kind) => {
    render(<AccessSection row={row({ kind })} actions={actions()} />)
    expect(screen.getByText("No grants to manage")).toBeInTheDocument()
    expect(screen.queryByTestId("grant-control")).not.toBeInTheDocument()
  })
})

describe("AccessSection — a device that belongs to somebody else", () => {
  function suspendedRow(): DeviceRow {
    return row({
      grants: buildGrantRows({
        hostCapabilities: ["agent.run", "workspace.read", "workspace.write"],
        mirror: {
          control: true,
          agentControl: false,
          terminal: false,
          sshFiles: false,
          lockedComputerUse: false,
        },
        revoked: false,
        ownerSuspended: true,
      }),
    })
  }

  it("says once, at the top, that the host is not honouring the grants", () => {
    render(<AccessSection row={suspendedRow()} actions={actions()} />)
    // One banner rather than four identical reason lines: the fact is about
    // the device, not about any one grant.
    expect(screen.getByTestId("device-access-owner-suspended")).toBeInTheDocument()
  })

  it("draws every switch off, because the host is refusing them right now", () => {
    render(<AccessSection row={suspendedRow()} actions={actions()} />)
    for (const id of [
      "paired-device-remote-control-d1",
      "paired-device-agent-control-d1",
      "paired-device-remote-terminal-d1",
    ]) {
      expect(screen.getByTestId(id)).not.toBeChecked()
    }
  })

  it("does not show the banner for an ordinary device", () => {
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.queryByTestId("device-access-owner-suspended")).not.toBeInTheDocument()
  })
})

/**
 * Access is written from a machine, not from an account. Every control on this
 * card maps to a `companion_*` command the manifest files as `target: "client"`
 * with `transports: ["internal"]`, which means the desktop renderer writes it
 * over Tauri IPC and no other shell can. Flipping one anywhere else used to
 * write the Dexie mirror, skip the host, and toast success.
 *
 * The terminal row was gated for exactly this reason and the rest were not, so
 * three switches and three buttons stayed live while being unwritable.
 */
describe("AccessSection — writing access off the desktop", () => {
  it("disables the terminal switch and says which block it is", () => {
    hostProfile = "mobile-companion"
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.getByTestId("paired-device-remote-terminal-d1")).toBeDisabled()
    expect(screen.getByTestId("grant-terminal-unavailable")).toBeInTheDocument()
  })

  it("disables every other grant for the same reason", () => {
    hostProfile = "mobile-companion"
    render(<AccessSection row={row()} actions={actions()} />)
    for (const id of [
      "paired-device-remote-control-d1",
      "paired-device-agent-control-d1",
      "paired-device-locked-computer-use-d1",
    ]) {
      expect(screen.getByTestId(id)).toBeDisabled()
    }
  })

  /**
   * Pause and revoke are the exception (ADR-0170 batch 4): every Host mounts
   * owner routes for them, so a paired companion reaches them over HTTP. Only
   * a standalone browser has nowhere to send the change.
   */
  it("keeps pause and revoke live for a paired companion", () => {
    hostProfile = "mobile-companion"
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.getByTestId("paired-device-pause-d1")).toBeEnabled()
    expect(screen.getByTestId("paired-device-revoke-d1")).toBeEnabled()
  })

  it("disables pause and revoke for a browser with no Host", () => {
    hostProfile = "web-standalone"
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.getByTestId("paired-device-pause-d1")).toBeDisabled()
    expect(screen.getByTestId("paired-device-revoke-d1")).toBeDisabled()
  })

  /**
   * One sentence for the card, not one per control. Four identical reason
   * lines beside four switches is the shape this file already rejected for
   * `ownerSuspended`.
   */
  it("explains it once for the whole section", () => {
    hostProfile = "mobile-companion"
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.getByTestId("device-access-shell-unavailable")).toBeInTheDocument()
  })

  it("says nothing when the desktop can write it", () => {
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.queryByTestId("grant-terminal-unavailable")).not.toBeInTheDocument()
    expect(screen.queryByTestId("device-access-shell-unavailable")).not.toBeInTheDocument()
    expect(screen.getByTestId("paired-device-remote-control-d1")).toBeEnabled()
    expect(screen.getByTestId("paired-device-pause-d1")).toBeEnabled()
  })

  /**
   * A grant whose blast radius grew has to say so where it is toggled, not
   * only where it is used. `terminal.open` now also opens this machine's saved
   * SSH hosts, and `ssh_profiles` is a shared map rather than a per-device one.
   */
  it("states that the grant now reaches this machine's saved SSH hosts", () => {
    render(<AccessSection row={row()} actions={actions()} />)
    expect(screen.getByTestId("grant-terminal-ssh-note")).toBeInTheDocument()
  })
})
