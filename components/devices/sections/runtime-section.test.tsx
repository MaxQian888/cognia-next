import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"

import { RuntimeSection } from "./runtime-section"

const activateHost = jest.fn()
const deactivate = jest.fn()
const writeAuthority = jest.fn()

jest.mock("@/components/settings/automation/sandbox-connections-tab", () => ({
  SandboxConnectionsTab: () => <div data-testid="sandbox-connections-tab" />,
}))

jest.mock("@/components/workspace/workspace-environment-list", () => ({
  WorkspaceEnvironmentList: () => <div data-testid="workspace-environment-list" />,
}))

jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (state: unknown) => unknown) =>
    selector({ activateHost, deactivate }),
}))

/**
 * The snapshot must be reference-stable between calls. `useSyncExternalStore`
 * re-renders whenever the snapshot identity changes, so a mock that builds a
 * fresh object each call loops forever — which is exactly what the real
 * module's cached snapshot exists to prevent.
 */
let authoritySnapshot = { hostId: null as string | null, degradeAfterMs: 1 }
const SERVER_SNAPSHOT = { hostId: null as string | null, degradeAfterMs: 1 }

const probe = jest.fn()
let probeState: unknown = { status: "idle" }
jest.mock("@/hooks/devices/use-host-probe", () => ({
  useHostProbe: (hostRef: string | null) => {
    probe.mockImplementation(() => {})
    return { state: hostRef ? probeState : { status: "idle" }, probe }
  },
}))

jest.mock("@/lib/placement/authority", () => ({
  subscribeExecutionAuthorityConfig: () => () => {},
  getExecutionAuthorityConfigSnapshot: () => authoritySnapshot,
  getExecutionAuthorityConfigServerSnapshot: () => SERVER_SNAPSHOT,
  writeExecutionAuthorityConfig: (config: unknown) => writeAuthority(config),
}))

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "local",
    kind: "local",
    label: "This Mac",
    isSelf: true,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "local" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "supported", connections: [] },
      shellTiers: [
        { tier: "os", available: true },
        { tier: "microvm", available: false, reasonKey: "microvmAdapterMissing" },
        { tier: "cua-desktop", available: false, reasonKey: "cuaDesktopRetired" },
      ],
      workspaces: { support: "supported" },
      isRoutingTarget: true,
    },
    ...overrides,
  }
}

beforeEach(() => {
  authoritySnapshot = { hostId: null, degradeAfterMs: 1 }
  jest.clearAllMocks()
})

describe("RuntimeSection — shell tiers", () => {
  it("lists cua-desktop and explains why it is withdrawn rather than hiding it", () => {
    render(<RuntimeSection row={row()} />)
    expect(screen.getByTestId("shell-tier-cua-desktop")).toBeInTheDocument()
    expect(screen.getByText(/Withdrawn/)).toBeInTheDocument()
  })

  /**
   * An unregistered microVM adapter makes `executeSandbox` throw
   * `microvm-unavailable` with host fallback forbidden, so the tier must not
   * look merely degraded.
   */
  it("explains that a missing microVM adapter is a refusal, not a fallback", () => {
    render(<RuntimeSection row={row()} />)
    expect(screen.getByText(/refused outright rather than falling back/)).toBeInTheDocument()
  })
})

describe("RuntimeSection — sandbox", () => {
  it("embeds the existing sandbox registry for this machine rather than a copy", () => {
    render(<RuntimeSection row={row()} />)
    expect(screen.getByTestId("sandbox-connections-tab")).toBeInTheDocument()
  })

  /**
   * `cua_sandbox_*` are client-target commands, so a Host's sandboxes are not
   * reachable from here at all — an empty list would imply it has none.
   */
  it("says a host's sandboxes are its own business", () => {
    render(
      <RuntimeSection
        row={row({
          kind: "remote-host",
          hostId: "h1",
          runtime: {
            ...row().runtime,
            sandbox: { support: "unsupported", reasonKey: "sandboxIsClientLocal", connections: [] },
          },
        })}
      />
    )
    expect(screen.queryByTestId("sandbox-connections-tab")).not.toBeInTheDocument()
    expect(screen.getByText(/never routed to another device/)).toBeInTheDocument()
  })
})

describe("RuntimeSection — workspaces", () => {
  it("renders the canonical inventory when this device is the routing target", () => {
    render(<RuntimeSection row={row()} />)
    expect(screen.getByTestId("workspace-environment-list")).toBeInTheDocument()
  })

  /**
   * `task_workspace_environment_list` is an execution-target command, so
   * reading it here while a Host is active would print that Host's worktrees
   * under this machine's name.
   */
  it("refuses to list local workspaces while execution routes elsewhere", async () => {
    render(
      <RuntimeSection
        row={row({
          runtime: {
            ...row().runtime,
            workspaces: { support: "requires-activation", reasonKey: "routedToRemoteHost" },
            isRoutingTarget: false,
          },
        })}
      />
    )
    expect(screen.queryByTestId("workspace-environment-list")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("activate-routing-target"))
    expect(deactivate).toHaveBeenCalled()
  })

  it("offers to activate an inactive host so its workspaces become readable", async () => {
    render(
      <RuntimeSection
        row={row({
          kind: "remote-host",
          hostId: "h1",
          runtime: {
            ...row().runtime,
            sandbox: { support: "unsupported", reasonKey: "sandboxIsClientLocal", connections: [] },
            workspaces: { support: "requires-activation", reasonKey: "activateToInspect" },
            isRoutingTarget: false,
          },
        })}
      />
    )
    await userEvent.click(screen.getByTestId("activate-routing-target"))
    expect(activateHost).toHaveBeenCalledWith("h1")
  })

  it("offers no activation for a device that cannot host workspaces at all", () => {
    render(
      <RuntimeSection
        row={row({
          kind: "paired-device",
          runtime: {
            sandbox: { support: "unsupported", reasonKey: "sandboxNotHosted", connections: [] },
            shellTiers: [],
            workspaces: { support: "unsupported", reasonKey: "workspaceNotHosted" },
            isRoutingTarget: false,
          },
        })}
      />
    )
    expect(screen.queryByTestId("activate-routing-target")).not.toBeInTheDocument()
    expect(
      screen.getByText("This kind of device does not host workspace environments.")
    ).toBeInTheDocument()
  })
})

describe("RuntimeSection — timing authority", () => {
  it("names this machine by clearing the configured host", async () => {
    authoritySnapshot = { hostId: "h1", degradeAfterMs: 1 }
    render(<RuntimeSection row={row()} />)
    expect(screen.getByTestId("timing-authority-switch")).toHaveAttribute("data-state", "unchecked")
    await userEvent.click(screen.getByTestId("timing-authority-switch"))
    expect(writeAuthority).toHaveBeenCalledWith(expect.objectContaining({ hostId: null }))
  })

  it("names a remote host by its store id", async () => {
    render(
      <RuntimeSection
        row={row({
          kind: "remote-host",
          hostId: "h1",
          runtime: {
            ...row().runtime,
            sandbox: { support: "unsupported", reasonKey: "sandboxIsClientLocal", connections: [] },
          },
        })}
      />
    )
    await userEvent.click(screen.getByTestId("timing-authority-switch"))
    expect(writeAuthority).toHaveBeenCalledWith(expect.objectContaining({ hostId: "h1" }))
  })

  /**
   * `ExecutionAuthorityConfig.hostId` is a `RemoteHost.id` or null — a phone
   * cannot be named, so offering the control there would be a lie.
   */
  it("is not offered for a device that cannot be named as the authority", () => {
    render(
      <RuntimeSection
        row={row({
          kind: "paired-device",
          runtime: {
            sandbox: { support: "unsupported", reasonKey: "sandboxNotHosted", connections: [] },
            shellTiers: [],
            workspaces: { support: "unsupported", reasonKey: "workspaceNotHosted" },
            isRoutingTarget: false,
          },
        })}
      />
    )
    expect(screen.queryByTestId("device-timing-authority")).not.toBeInTheDocument()
  })

  /**
   * An inactive Host used to offer nothing but "Activate", which meant reading
   * one machine's worktrees required pointing the whole desktop at it.
   * `openRemoteHostTarget` opens an isolated transport for exactly this and
   * had no UI caller.
   */
  describe("an inactive remote host", () => {
    const inactiveHost = () =>
      row({
        ref: "host:h1",
        kind: "remote-host",
        hostId: "h1",
        label: "Dev box",
        isSelf: false,
        runtime: {
          sandbox: { support: "unsupported", reasonKey: "sandboxIsClientLocal", connections: [] },
          shellTiers: [],
          workspaces: { support: "requires-activation", reasonKey: "routedToRemoteHost" },
          isRoutingTarget: false,
        },
      })

    beforeEach(() => {
      probeState = { status: "idle" }
      probe.mockClear()
    })

    it("can be read without being made the routing target", async () => {
      render(<RuntimeSection row={inactiveHost()} />)
      await userEvent.click(screen.getByTestId("probe-host-workspaces"))
      expect(probe).toHaveBeenCalled()
      expect(activateHost).not.toHaveBeenCalled()
    })

    it("still offers activation, because writing needs the routing target", () => {
      render(<RuntimeSection row={inactiveHost()} />)
      expect(screen.getByTestId("activate-routing-target")).toBeInTheDocument()
    })

    it("says where the probed rows came from", () => {
      probeState = {
        status: "ready",
        environments: [{ environmentId: "e1", path: "/w", branch: "main" }],
      }
      render(<RuntimeSection row={inactiveHost()} />)
      expect(screen.getByTestId("host-probe-result")).toHaveTextContent("/w")
    })

    it("reports a failed probe rather than an empty host", () => {
      probeState = { status: "error", message: "credential is unavailable" }
      render(<RuntimeSection row={inactiveHost()} />)
      expect(screen.getByTestId("host-probe-error")).toHaveTextContent("credential is unavailable")
      expect(screen.queryByTestId("host-probe-result")).not.toBeInTheDocument()
    })

    /**
     * `requires-activation` on the LOCAL row means a Host is active and
     * routing points away from here. There is no second transport back to this
     * machine, so offering a probe there would be a button that cannot work.
     */
    it("offers no probe on the local row", () => {
      render(
        <RuntimeSection
          row={row({
            runtime: {
              sandbox: { support: "supported", connections: [] },
              shellTiers: [],
              workspaces: { support: "requires-activation", reasonKey: "routedToRemoteHost" },
              isRoutingTarget: false,
            },
          })}
        />
      )
      expect(screen.queryByTestId("probe-host-workspaces")).not.toBeInTheDocument()
      expect(screen.getByTestId("activate-routing-target")).toBeInTheDocument()
    })
  })
})
