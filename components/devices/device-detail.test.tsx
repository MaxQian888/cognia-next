import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceCapabilityCell, DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { DeviceDetail } from "./device-detail"

// The cards are covered by their own suites; here they stand in as markers
// carrying the anchor id each real card has, so the assertions are about
// composition (which cards appear, in what order, what the jump strip lists)
// rather than about anything they render.
function marker(id: string) {
  return function Marker() {
    return <section id={`device-section-${id}`} data-testid={`card-${id}`} />
  }
}
jest.mock("./sections/overview-section", () => ({
  IdentitySection: marker("identity"),
  PresenceSection: marker("presence"),
  EventPlaneSection: marker("event-plane"),
}))
jest.mock("./sections/capabilities-section", () => ({
  CapabilitiesSection: marker("capabilities"),
}))
jest.mock("./sections/access-section", () => ({ AccessSection: marker("access") }))
jest.mock("./sections/runtime-section", () => ({
  RoutingSection: marker("routing"),
  ShellTiersSection: marker("shell-tiers"),
  SandboxSection: marker("sandbox"),
  WorkspacesSection: marker("workspaces"),
}))
jest.mock("./sections/activity-section", () => ({
  DispatchSection: marker("dispatch"),
  PlacementSection: marker("placement"),
}))
jest.mock("./sections/wan-section", () => ({ WanSection: marker("wan") }))
jest.mock("./sections/files-section", () => ({ FilesSection: marker("files") }))
jest.mock("./ssh-host-controls", () => ({
  SshHostControls: () => <div data-testid="ssh-controls" />,
}))

const actions = {
  pause: jest.fn(async () => {}),
  resume: jest.fn(async () => {}),
  revoke: jest.fn(async () => {}),
} as unknown as DeviceGrantActions

const CELL: DeviceCapabilityCell = {
  id: "pty",
  group: "platform",
  state: "reported",
  source: "device-report",
}

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Max's iPhone",
    isSelf: false,
    deviceId: "a",
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [CELL],
    capabilityReportMissing: false,
    grants: [],
    wan: { state: "automatic", canWake: false },
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", reasonKey: "sandboxNotHosted", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported", reasonKey: "workspaceNotHosted" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

/** Card ids in the order the grid rendered them. */
function renderedCards(): string[] {
  return screen
    .getAllByTestId(/^(card-|device-section-not-applicable$|ssh-controls$)/)
    .map((element) => element.getAttribute("data-testid")!.replace(/^card-/, ""))
}

describe("DeviceDetail", () => {
  it("explains an empty pane instead of rendering blank chrome", () => {
    render(<DeviceDetail row={null} actions={actions} />)
    expect(screen.getByTestId("device-detail-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("device-detail")).not.toBeInTheDocument()
  })

  it("heads the pane with the device's identity", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    expect(screen.getByTestId("device-hero")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Max's iPhone" })).toBeInTheDocument()
  })

  /**
   * Owning a phone is mostly about its grants, and those used to sit below a
   * twenty-row capability matrix. The plan puts them first.
   */
  it("lays a phone out task-first, with no tab bar", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    expect(renderedCards()).toEqual([
      "access",
      "wan",
      "presence",
      "identity",
      // Pulled up beside `identity`, which would otherwise sit beside a gap
      // above the wide dispatch card (`packHalfSections`).
      "placement",
      "dispatch",
      "capabilities",
      "device-section-not-applicable",
    ])
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("lays this machine out by what it runs", () => {
    render(
      <DeviceDetail
        row={row({
          ref: "local",
          kind: "local",
          isSelf: true,
          deviceId: undefined,
          wan: undefined,
          runtime: {
            sandbox: { support: "supported", connections: [] },
            shellTiers: [{ tier: "os", available: true }],
            workspaces: { support: "supported" },
            isRoutingTarget: true,
          },
        })}
        actions={actions}
      />
    )
    expect(renderedCards().slice(0, 4)).toEqual(["routing", "shell-tiers", "workspaces", "sandbox"])
  })

  /**
   * A card frame around one sentence was the shape of every "not here" answer.
   * They are one record at the end, in the same words.
   */
  it("states what does not apply once, in a record at the end", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    const record = screen.getByTestId("device-section-not-applicable")
    expect(within(record).getByTestId("not-applicable-sandbox")).toHaveTextContent(
      "This kind of device does not host sandboxes."
    )
    expect(within(record).getByTestId("not-applicable-workspaces")).toBeInTheDocument()
    expect(screen.queryByTestId("card-sandbox")).not.toBeInTheDocument()
  })

  it("lists every rendered card in the jump strip, in grid order", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    const strip = screen.getByTestId("device-section-nav")
    expect(
      within(strip)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual([
      "Access",
      "WAN connection",
      "Presence",
      "Identity",
      "Placement",
      "Dispatch queue",
      "Capabilities",
      "Not applicable",
    ])
  })

  it("jumps to a card from the strip and marks it as the one in view", async () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    // Let the strip take its first reading, which a browser does one frame
    // after mount, long before anyone can click.
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const chip = screen.getByTestId("device-section-nav-device-section-capabilities")
    await userEvent.click(chip)
    expect(chip).toHaveAttribute("aria-current", "location")
  })

  /** The device's verbs are in the masthead, beside its name. */
  it("puts a phone's lifecycle controls in the masthead", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    expect(screen.getByTestId("device-hero")).toContainElement(
      screen.getByTestId("paired-device-pause-a")
    )
  })

  it("opens the scroll with the device's numbers", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    expect(screen.getByTestId("device-stat-strip")).toBeInTheDocument()
    expect(screen.getByTestId("device-hero")).not.toContainElement(
      screen.getByTestId("device-stat-strip")
    )
  })

  /**
   * These two are about the machine rather than about any one question, so
   * they sit above the grid instead of inside a card — and they must not be
   * inside a section that could be scrolled past.
   */
  it("raises a host/mirror lifecycle disagreement above the grid", () => {
    render(<DeviceDetail row={row({ adminStateConflict: true })} actions={actions} />)
    expect(screen.getByTestId("device-admin-conflict")).toBeInTheDocument()
  })

  it("says a host's last connection error once", () => {
    render(
      <DeviceDetail
        row={row({
          ref: "host:h1",
          kind: "remote-host",
          hostId: "h1",
          connectionState: "degraded",
          connectionError: "handshake refused",
        })}
        actions={actions}
      />
    )
    expect(screen.getAllByText("handshake refused")).toHaveLength(1)
    expect(screen.getByTestId("device-connection-error")).toHaveTextContent("handshake refused")
  })

  it("stays quiet when there is nothing wrong", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    expect(screen.queryByTestId("device-admin-conflict")).not.toBeInTheDocument()
    expect(screen.queryByTestId("device-connection-error")).not.toBeInTheDocument()
  })

  /**
   * One scroll means the offset is shared across devices. Landing mid-way
   * through a different machine's dashboard, with no signal that is what
   * happened, is the failure this guards.
   */
  it("returns to the top when the selected device changes", () => {
    const { container, rerender } = render(<DeviceDetail row={row()} actions={actions} />)
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")
    expect(scroller).not.toBeNull()

    scroller!.scrollTop = 220
    rerender(<DeviceDetail row={row({ ref: "device:b" })} actions={actions} />)
    expect(scroller!.scrollTop).toBe(0)

    // Re-rendering the same device must not yank the reader back up.
    scroller!.scrollTop = 220
    rerender(<DeviceDetail row={row({ ref: "device:b", label: "Renamed" })} actions={actions} />)
    expect(scroller!.scrollTop).toBe(220)
  })
})

/**
 * A saved SSH host is not a Cognia machine. It reports no capabilities, holds
 * no grants, hosts neither a sandbox nor a workspace, and the dispatcher
 * cannot address it.
 */
describe("a machine that can only give a shell", () => {
  const sshRow = row({
    kind: "ssh-host",
    ref: "ssh:s1",
    label: "prod-web-01",
    deviceId: undefined,
    capabilities: [],
    wan: undefined,
  })

  it("gives it the SSH card, its files, and one record of what does not apply", () => {
    render(<DeviceDetail row={sshRow} actions={actions} />)
    expect(renderedCards()).toEqual([
      "ssh-controls",
      "files",
      "identity",
      "presence",
      "device-section-not-applicable",
    ])
  })

  /**
   * It holds a record, a list of forwarding rules and three controls. In half
   * a pane that is a ribbon several hundred pixels taller than the identity
   * card beside it.
   */
  it("puts the SSH card across the pane rather than in a column", () => {
    render(<DeviceDetail row={sshRow} actions={actions} />)
    expect(screen.getByTestId("device-section-ssh").className).toContain(
      "@3xl/device-pane:col-span-2"
    )
  })

  it("spans the record across the pane when it has more than two rows", () => {
    render(<DeviceDetail row={sshRow} actions={actions} />)
    expect(screen.getByTestId("device-section-not-applicable").className).toContain(
      "@3xl/device-pane:col-span-2"
    )
  })
  /**
   * "Browse files" on a live SSH tab links here with `?deviceSection=files`.
   * The link is spent once applied, so a later row change does not scroll the
   * pane back to it.
   */
  it("applies a deep-linked section once and reports it spent", () => {
    const applied = jest.fn()
    const { rerender } = render(
      <DeviceDetail
        row={sshRow}
        actions={actions}
        initialSection="files"
        onInitialSectionApplied={applied}
      />
    )
    expect(applied).toHaveBeenCalledTimes(1)
    rerender(<DeviceDetail row={sshRow} actions={actions} initialSection={null} />)
    expect(applied).toHaveBeenCalledTimes(1)
  })

  it("spends a link naming a section this row does not have", () => {
    const applied = jest.fn()
    render(
      <DeviceDetail
        row={sshRow}
        actions={actions}
        initialSection="wan"
        onInitialSectionApplied={applied}
      />
    )
    expect(applied).toHaveBeenCalledTimes(1)
  })
})
