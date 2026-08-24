import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"

import { RuntimeTab } from "./runtime-tab"

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

describe("RuntimeTab — shell tiers", () => {
  it("lists cua-desktop and explains why it is withdrawn rather than hiding it", () => {
    render(<RuntimeTab row={row()} />)
    expect(screen.getByTestId("shell-tier-cua-desktop")).toBeInTheDocument()
    expect(screen.getByText(/Withdrawn/)).toBeInTheDocument()
  })

  /**
   * An unregistered microVM adapter makes `executeSandbox` throw
   * `microvm-unavailable` with host fallback forbidden, so the tier must not
   * look merely degraded.
   */
  it("explains that a missing microVM adapter is a refusal, not a fallback", () => {
    render(<RuntimeTab row={row()} />)
    expect(screen.getByText(/refused outright rather than falling back/)).toBeInTheDocument()
  })
})

describe("RuntimeTab — sandbox", () => {
  it("embeds the existing sandbox registry for this machine rather than a copy", () => {
    render(<RuntimeTab row={row()} />)
    expect(screen.getByTestId("sandbox-connections-tab")).toBeInTheDocument()
  })

  /**
   * `cua_sandbox_*` are client-target commands, so a Host's sandboxes are not
   * reachable from here at all — an empty list would imply it has none.
   */
  it("says a host's sandboxes are its own business", () => {
    render(
      <RuntimeTab
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

describe("RuntimeTab — workspaces", () => {
  it("renders the canonical inventory when this device is the routing target", () => {
    render(<RuntimeTab row={row()} />)
    expect(screen.getByTestId("workspace-environment-list")).toBeInTheDocument()
  })

  /**
   * `task_workspace_environment_list` is an execution-target command, so
   * reading it here while a Host is active would print that Host's worktrees
   * under this machine's name.
   */
  it("refuses to list local workspaces while execution routes elsewhere", async () => {
    render(
      <RuntimeTab
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
      <RuntimeTab
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
      <RuntimeTab
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

describe("RuntimeTab — timing authority", () => {
  it("names this machine by clearing the configured host", async () => {
    authoritySnapshot = { hostId: "h1", degradeAfterMs: 1 }
    render(<RuntimeTab row={row()} />)
    expect(screen.getByTestId("timing-authority-switch")).toHaveAttribute("data-state", "unchecked")
    await userEvent.click(screen.getByTestId("timing-authority-switch"))
    expect(writeAuthority).toHaveBeenCalledWith(expect.objectContaining({ hostId: null }))
  })

  it("names a remote host by its store id", async () => {
    render(
      <RuntimeTab
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
      <RuntimeTab
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
})
