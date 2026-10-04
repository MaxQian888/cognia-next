import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { DeviceHero, DeviceStatSummary } from "./device-hero"

const activateHost = jest.fn()
const deactivate = jest.fn()
const removeHost = jest.fn()
const updateHostLabel = jest.fn()

// Host verbs run through `useExecutionHostSwitch`, which reads the registry at
// request time (`getState()`) and checks for an in-flight turn first.
jest.mock("@/lib/devices/execution-host-guard", () => ({
  anyRunActive: () => Promise.resolve(false),
}))
const mockHostState = () => ({
  hosts: [{ id: "h1", label: "h1" }],
  activeHostId: null,
  activateHost,
  deactivate,
  removeHost,
  updateHostLabel,
})
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(mockHostState()),
    { getState: () => mockHostState() }
  ),
}))

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

beforeEach(() => jest.clearAllMocks())

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Max's iPhone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    lastSeenAt: Date.now() - 20_000,
    appVersion: "1.4.2",
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

describe("DeviceHero", () => {
  it("names the device, its kind and its reachability", () => {
    render(<DeviceHero row={row()} />)
    expect(screen.getByRole("heading", { name: "Max's iPhone" })).toBeInTheDocument()
    expect(screen.getByText("Paired device")).toBeInTheDocument()
    expect(screen.getByText("Online")).toBeInTheDocument()
  })

  it("shows a host's address where another kind shows its version", () => {
    const { rerender } = render(<DeviceHero row={row()} />)
    expect(screen.getByText("v1.4.2")).toBeInTheDocument()

    rerender(<DeviceHero row={row({ kind: "remote-host", baseUrl: "https://build.local:8443" })} />)
    expect(screen.getByText("https://build.local:8443")).toBeInTheDocument()
  })

  /**
   * "Last seen 3 seconds ago" under the name of the machine you are sitting
   * at is noise dressed as a fact.
   */
  it("omits a last-seen time for this machine", () => {
    render(<DeviceHero row={row({ kind: "local", isSelf: true, label: "This Mac" })} />)
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it("renders a stat per answerable question and nothing for the rest", () => {
    render(
      <DeviceStatSummary
        row={row({
          capabilities: [
            { id: "camera", group: "platform", state: "reported", source: "device-report" },
            { id: "ocr", group: "platform", state: "absent", source: "device-report" },
          ],
        })}
      />
    )
    expect(screen.getByTestId("device-stat-capabilities")).toHaveTextContent("1/2")
    // A phone with no grants loaded and no tiers gets neither slot.
    expect(screen.queryByTestId("device-stat-grants")).not.toBeInTheDocument()
    expect(screen.queryByTestId("device-stat-shellTiers")).not.toBeInTheDocument()
    expect(screen.getByTestId("device-stat-placement")).toBeInTheDocument()
  })

  it("badges a lifecycle state that is not active, and stays quiet when it is", () => {
    const { rerender } = render(<DeviceHero row={row()} />)
    expect(screen.queryByText("Revoked")).not.toBeInTheDocument()

    rerender(<DeviceHero row={row({ adminState: "revoked" })} />)
    expect(screen.getByText("Revoked")).toBeInTheDocument()
  })
})

describe("DeviceHero — actions beside the name", () => {
  const host = (overrides: Partial<DeviceRow> = {}) =>
    row({ ref: "host:h1", kind: "remote-host", hostId: "h1", label: "Build box", ...overrides })

  /**
   * The stat strip is a reading of the device, not part of its name, so it
   * is the dashboard's first block now rather than fixed chrome.
   */
  it("keeps the stat strip out of the masthead", () => {
    render(<DeviceHero row={row()} />)
    expect(screen.queryByTestId("device-stat-strip")).not.toBeInTheDocument()
  })

  it("puts a host's connect control in the masthead", async () => {
    render(<DeviceHero row={host()} />)
    await userEvent.click(screen.getByTestId("host-connect"))
    expect(activateHost).toHaveBeenCalledWith("h1")
  })

  it("states a host's handshake beside its reachability", () => {
    render(<DeviceHero row={host({ connectionState: "degraded" })} />)
    expect(screen.getByTestId("host-connection-state")).toHaveAttribute("data-state", "degraded")
  })

  it("puts a phone's pause and revoke in the masthead", () => {
    render(<DeviceHero row={row({ deviceId: "d1" })} actions={actions()} />)
    expect(screen.getByTestId("paired-device-pause-d1")).toBeInTheDocument()
    expect(screen.getByTestId("paired-device-revoke-d1")).toBeInTheDocument()
  })

  it("offers no verbs for this machine", () => {
    render(<DeviceHero row={row({ kind: "local", isSelf: true })} actions={actions()} />)
    expect(screen.queryByTestId("device-host-controls")).not.toBeInTheDocument()
    expect(screen.queryByTestId("paired-device-lifecycle")).not.toBeInTheDocument()
  })

  it("renders the jump strip it is handed under the identity", () => {
    render(
      <DeviceHero row={row()}>
        <nav data-testid="strip" />
      </DeviceHero>
    )
    expect(screen.getByTestId("device-hero")).toContainElement(screen.getByTestId("strip"))
  })
})

describe("DeviceHero — renaming a host in its own title", () => {
  const host = () => row({ ref: "host:h1", kind: "remote-host", hostId: "h1", label: "Build box" })

  async function startRename() {
    const user = userEvent.setup()
    render(<DeviceHero row={host()} />)
    await user.click(screen.getByTestId("host-more"))
    await user.click(screen.getByTestId("host-rename"))
    return user
  }

  it("commits the trimmed label", async () => {
    const user = await startRename()
    const input = screen.getByTestId("host-rename-input")
    await user.clear(input)
    await user.type(input, "  CI box  ")
    await user.click(screen.getByTestId("host-rename-save"))
    expect(updateHostLabel).toHaveBeenCalledWith("h1", "CI box")
    expect(screen.queryByTestId("host-rename-input")).not.toBeInTheDocument()
  })

  it("commits on Enter", async () => {
    const user = await startRename()
    const input = screen.getByTestId("host-rename-input")
    await user.clear(input)
    await user.type(input, "CI box{Enter}")
    expect(updateHostLabel).toHaveBeenCalledWith("h1", "CI box")
  })

  /**
   * An empty label leaves a row that cannot be told apart from any other
   * unnamed host, so it is simply not a rename.
   */
  it("treats an empty label as a cancel", async () => {
    const user = await startRename()
    await user.clear(screen.getByTestId("host-rename-input"))
    await user.click(screen.getByTestId("host-rename-save"))
    expect(updateHostLabel).not.toHaveBeenCalled()
  })

  it("abandons a rename on Cancel without writing anything", async () => {
    const user = await startRename()
    await user.type(screen.getByTestId("host-rename-input"), "x")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(updateHostLabel).not.toHaveBeenCalled()
    expect(screen.getByRole("heading", { name: "Build box" })).toBeInTheDocument()
  })

  it("abandons a rename on Escape", async () => {
    const user = await startRename()
    await user.type(screen.getByTestId("host-rename-input"), "x{Escape}")
    expect(updateHostLabel).not.toHaveBeenCalled()
  })
})
