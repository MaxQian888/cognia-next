import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"

import { DeviceListPane, filterDeviceRows, matchesDeviceSearch } from "./device-list-pane"

const NOW = 1_700_000_000_000

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Max's iPhone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: NOW, source: "request" },
    lastSeenAt: NOW,
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

const LOCAL = row({ ref: "local", kind: "local", label: "This Mac", isSelf: true })
const HOST = row({
  ref: "host-1",
  kind: "remote-host",
  label: "Build box",
  baseUrl: "https://build.local",
})
const PHONE = row()

function renderPane(props: Partial<React.ComponentProps<typeof DeviceListPane>> = {}) {
  const onSelect = jest.fn()
  render(
    <DeviceListPane
      rows={[LOCAL, HOST, PHONE]}
      selectedRef={null}
      search=""
      kindFilter="all"
      onSearchChange={jest.fn()}
      onKindFilterChange={jest.fn()}
      onSelect={onSelect}
      {...props}
    />
  )
  return { onSelect }
}

describe("matchesDeviceSearch", () => {
  it("matches on the fields a person would type", () => {
    expect(matchesDeviceSearch(HOST, "build")).toBe(true)
    expect(matchesDeviceSearch(HOST, "BUILD.LOCAL")).toBe(true)
    expect(matchesDeviceSearch(HOST, "host-1")).toBe(true)
    expect(matchesDeviceSearch(HOST, "iphone")).toBe(false)
  })

  it("treats an empty or whitespace query as no filter", () => {
    expect(matchesDeviceSearch(PHONE, "")).toBe(true)
    expect(matchesDeviceSearch(PHONE, "   ")).toBe(true)
  })
})

describe("filterDeviceRows", () => {
  it("applies kind and search together", () => {
    expect(filterDeviceRows([LOCAL, HOST, PHONE], "", "remote-host")).toEqual([HOST])
    expect(filterDeviceRows([LOCAL, HOST, PHONE], "mac", "all")).toEqual([LOCAL])
    expect(filterDeviceRows([LOCAL, HOST, PHONE], "mac", "remote-host")).toEqual([])
  })
})

describe("DeviceListPane", () => {
  /**
   * Grouped rather than flat: a phone is something you grant and a Host is
   * something you drive, and a single ordered list makes the reader re-derive
   * which is which on every row.
   */
  it("groups rows by kind under translated headings", () => {
    renderPane()
    expect(screen.getByRole("heading", { name: "This device" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Remote host" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Paired device" })).toBeInTheDocument()
  })

  it("omits a group that has no rows rather than showing an empty heading", () => {
    render(
      <DeviceListPane
        rows={[LOCAL]}
        selectedRef={null}
        search=""
        kindFilter="all"
        onSearchChange={jest.fn()}
        onKindFilterChange={jest.fn()}
        onSelect={jest.fn()}
      />
    )
    expect(screen.queryByRole("heading", { name: "Execution worker" })).not.toBeInTheDocument()
  })

  it("selects a row", async () => {
    const { onSelect } = renderPane()
    await userEvent.click(screen.getByTestId("device-row-host-1"))
    expect(onSelect).toHaveBeenCalledWith("host-1")
  })

  it("reports the search box as it is typed", async () => {
    const onSearchChange = jest.fn()
    renderPane({ onSearchChange })
    await userEvent.type(screen.getByTestId("device-search"), "b")
    expect(onSearchChange).toHaveBeenCalledWith("b")
  })

  it("says nothing is paired when there is genuinely nothing", () => {
    renderPane({ rows: [] })
    expect(
      screen.getByText("Pair a phone or add a remote host to see it here.")
    ).toBeInTheDocument()
  })

  /**
   * An empty result caused by a filter is a different problem from an empty
   * fleet, and telling the user to pair a phone when they have three is how a
   * console loses trust.
   */
  it("distinguishes an empty filter result from an empty fleet", () => {
    renderPane({ search: "nothing-matches" })
    expect(screen.getByText("No device matches the current search or filter.")).toBeInTheDocument()
  })

  it("labels the search and filter controls for assistive tech", () => {
    renderPane()
    expect(screen.getByLabelText("Search devices by name, address or platform")).toBeInTheDocument()
    expect(screen.getByLabelText("Filter by device kind")).toBeInTheDocument()
  })
})
