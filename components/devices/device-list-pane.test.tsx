import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"

import {
  countDeviceKinds,
  DeviceListPane,
  filterDeviceRows,
  matchesDeviceSearch,
  nextRowRef,
} from "./device-list-pane"

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

const REVOKED = row({ ref: "device:r", label: "Old tablet", adminState: "revoked" })

function renderPane(props: Partial<React.ComponentProps<typeof DeviceListPane>> = {}) {
  const onSelect = jest.fn()
  const onKindFilterChange = jest.fn()
  const onAttentionOnlyChange = jest.fn()
  const onClearFilters = jest.fn()
  render(
    <DeviceListPane
      rows={[LOCAL, HOST, PHONE]}
      selectedRef={null}
      search=""
      kindFilter="all"
      attentionOnly={false}
      onSearchChange={jest.fn()}
      onKindFilterChange={onKindFilterChange}
      onAttentionOnlyChange={onAttentionOnlyChange}
      onClearFilters={onClearFilters}
      onSelect={onSelect}
      {...props}
    />
  )
  return { onSelect, onKindFilterChange, onAttentionOnlyChange, onClearFilters }
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

  it("narrows to the rows that need attention, alongside the other filters", () => {
    expect(filterDeviceRows([LOCAL, PHONE, REVOKED], "", "all", true)).toEqual([REVOKED])
    expect(filterDeviceRows([LOCAL, PHONE, REVOKED], "", "remote-host", true)).toEqual([])
  })
})

describe("countDeviceKinds", () => {
  it("counts per kind in rail order and drops kinds the fleet lacks", () => {
    expect(countDeviceKinds([PHONE, LOCAL, HOST, REVOKED])).toEqual([
      { kind: "local", count: 1 },
      { kind: "remote-host", count: 1 },
      { kind: "paired-device", count: 2 },
    ])
  })
})

describe("nextRowRef", () => {
  const refs = ["a", "b", "c"]
  it("moves by one and stops at either end", () => {
    expect(nextRowRef(refs, "a", "ArrowDown")).toBe("b")
    expect(nextRowRef(refs, "c", "ArrowDown")).toBe("c")
    expect(nextRowRef(refs, "b", "ArrowUp")).toBe("a")
    expect(nextRowRef(refs, "a", "ArrowUp")).toBe("a")
  })

  it("jumps to the ends, and starts from the top with nothing selected", () => {
    expect(nextRowRef(refs, "b", "Home")).toBe("a")
    expect(nextRowRef(refs, "a", "End")).toBe("c")
    expect(nextRowRef(refs, null, "ArrowDown")).toBe("a")
    expect(nextRowRef(refs, "gone", "ArrowDown")).toBe("a")
  })

  it("ignores every other key, and an empty list", () => {
    expect(nextRowRef(refs, "a", "Enter")).toBeNull()
    expect(nextRowRef([], null, "ArrowDown")).toBeNull()
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
    renderPane({ rows: [LOCAL] })
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

  it("offers a way out of a filter that matches nothing", async () => {
    const { onClearFilters } = renderPane({ search: "nothing-matches" })
    await userEvent.click(screen.getByTestId("device-clear-filters"))
    expect(onClearFilters).toHaveBeenCalled()
  })

  it("offers no clear button for a genuinely empty fleet", () => {
    renderPane({ rows: [] })
    expect(screen.queryByTestId("device-clear-filters")).not.toBeInTheDocument()
  })

  it("labels the search and filter controls for assistive tech", () => {
    renderPane()
    expect(screen.getByLabelText("Search devices by name, address or platform")).toBeInTheDocument()
    expect(screen.getByLabelText("Filter by device kind")).toBeInTheDocument()
  })
})

describe("DeviceListPane — filters", () => {
  /**
   * The dropdown offered all five kinds whatever the fleet held, so picking
   * "Execution worker" in a fleet with none produced an empty list.
   */
  it("offers a chip, with its count, only for kinds the fleet has", () => {
    renderPane({ rows: [LOCAL, HOST, PHONE, REVOKED] })
    expect(screen.getByTestId("device-filter-all")).toHaveTextContent("4")
    expect(screen.getByTestId("device-filter-paired-device")).toHaveTextContent("2")
    expect(screen.queryByTestId("device-filter-worker")).not.toBeInTheDocument()
  })

  it("filters by kind, and a second click on the chip clears it", async () => {
    const user = userEvent.setup()
    const { onKindFilterChange } = renderPane()
    await user.click(screen.getByTestId("device-filter-remote-host"))
    expect(onKindFilterChange).toHaveBeenLastCalledWith("remote-host")
  })

  it("treats deselecting the active chip as no kind filter", async () => {
    const user = userEvent.setup()
    const { onKindFilterChange } = renderPane({ kindFilter: "remote-host" })
    await user.click(screen.getByTestId("device-filter-remote-host"))
    expect(onKindFilterChange).toHaveBeenLastCalledWith("all")
  })

  it("keeps a chip for an active filter whose last row has gone, so it can be turned off", () => {
    renderPane({ kindFilter: "worker" })
    expect(screen.getByTestId("device-filter-worker")).toHaveTextContent("0")
  })

  it("hides the chip row when it could filter nothing", () => {
    renderPane({ rows: [LOCAL] })
    expect(screen.queryByTestId("device-filters")).not.toBeInTheDocument()
  })

  it("offers the attention filter only while something needs attention", async () => {
    const { onAttentionOnlyChange } = renderPane({ rows: [LOCAL, PHONE, REVOKED] })
    const chip = screen.getByTestId("device-filter-attention")
    expect(chip).toHaveTextContent("1")
    expect(chip).toHaveAttribute("aria-pressed", "false")
    await userEvent.click(chip)
    expect(onAttentionOnlyChange).toHaveBeenCalledWith(true)
  })

  it("keeps the attention chip while it is on, so it can be switched off", () => {
    renderPane({ rows: [LOCAL, HOST, PHONE], attentionOnly: true })
    expect(screen.getByTestId("device-filter-attention")).toHaveAttribute("aria-pressed", "true")
  })

  it("has no attention chip in a healthy fleet", () => {
    renderPane()
    expect(screen.queryByTestId("device-filter-attention")).not.toBeInTheDocument()
  })
})

describe("DeviceListPane — keyboard", () => {
  it("moves the selection with the arrow keys, in the order the rows are drawn", async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPane({ selectedRef: "local" })
    screen.getByTestId("device-row-local").focus()
    await user.keyboard("{ArrowDown}")
    // Groups are drawn local, remote host, paired device.
    expect(onSelect).toHaveBeenLastCalledWith("host-1")
    expect(screen.getByTestId("device-row-host-1")).toHaveFocus()
    await user.keyboard("{End}")
    expect(onSelect).toHaveBeenLastCalledWith("device:a")
  })
})

describe("DeviceListPane — slots", () => {
  it("renders fleet notices above the rows and the footer below them", () => {
    renderPane({
      notices: <p data-testid="notice" />,
      footer: <p data-testid="footer" />,
    })
    const rows = screen.getByTestId("device-rows")
    expect(screen.getByTestId("notice").compareDocumentPosition(rows)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(rows.compareDocumentPosition(screen.getByTestId("footer"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })
})

describe("DeviceListPane — first read", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  /**
   * A slow host read must not read as a finished fleet of one, nor as
   * "nothing matches" about rows that have not arrived yet.
   */
  it("holds placeholders under the known rows while the first read is in flight", () => {
    jest.useFakeTimers()
    renderPane({ rows: [LOCAL], loading: true })
    // Under the anti-flicker delay nothing extra is drawn…
    expect(screen.queryByTestId("device-list-loading")).not.toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(250)
    })
    // …past it the rail says it is still reading, below what is known.
    expect(screen.getByTestId("device-list-loading")).toHaveTextContent("Loading devices…")
    expect(screen.getByTestId("device-row-local")).toBeInTheDocument()
  })

  it("does not claim an empty result while rows are still arriving", () => {
    jest.useFakeTimers()
    renderPane({ rows: [], loading: true })
    expect(screen.queryByText("No devices")).not.toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(250)
    })
    expect(screen.getByTestId("device-list-loading")).toBeInTheDocument()
    expect(screen.queryByText("No devices")).not.toBeInTheDocument()
  })

  it("draws no placeholders once the read has settled", () => {
    renderPane({ rows: [LOCAL], loading: false })
    expect(screen.queryByTestId("device-list-loading")).not.toBeInTheDocument()
  })
})
