import { render, screen, within } from "@testing-library/react"

import type { DeviceCapabilityCell, DeviceRow } from "@/lib/devices/types"

import { CapabilitiesSection, sortCapabilityCells } from "./capabilities-section"

function cell(overrides: Partial<DeviceCapabilityCell> & { id: string }): DeviceCapabilityCell {
  return { group: "platform", state: "reported", source: "device-report", ...overrides }
}

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Phone",
    isSelf: false,
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

describe("sortCapabilityCells", () => {
  /**
   * The reader's question in a console is almost always "why can this machine
   * not do X", so the cells that answer it lead.
   */
  it("puts unconfirmed first and working last", () => {
    const sorted = sortCapabilityCells([
      cell({ id: "d", state: "reported" }),
      cell({ id: "c", state: "absent" }),
      cell({ id: "b", state: "expected" }),
      cell({ id: "a", state: "unknown" }),
    ])
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c", "d"])
  })

  it("breaks ties by id so the order never shuffles between renders", () => {
    const sorted = sortCapabilityCells([
      cell({ id: "zeta", state: "reported" }),
      cell({ id: "alpha", state: "reported" }),
    ])
    expect(sorted.map((c) => c.id)).toEqual(["alpha", "zeta"])
  })
})

describe("CapabilitiesSection", () => {
  /**
   * One explanatory banner instead of twenty `absent` rows: the device has told
   * us nothing, and a column of misses would state negatives nobody gave.
   */
  it("explains an unreported device once, and marks nothing as a miss", () => {
    render(
      <CapabilitiesSection
        row={row({
          capabilityReportMissing: true,
          capabilities: [
            cell({ id: "camera", state: "expected", source: "platform-baseline" }),
            cell({ id: "shell", state: "unknown", source: "platform-baseline" }),
          ],
        })}
      />
    )
    expect(screen.getByTestId("capability-never-reported")).toBeInTheDocument()
    expect(screen.queryByText("Not available")).not.toBeInTheDocument()
    expect(screen.getByText("Expected")).toBeInTheDocument()
    expect(screen.getByText("Unconfirmed")).toBeInTheDocument()
  })

  it("does not show the banner once the device has reported", () => {
    render(
      <CapabilitiesSection
        row={row({
          capabilitiesReportedAt: 1_700_000_000_000,
          capabilities: [cell({ id: "camera" }), cell({ id: "ocr", state: "absent" })],
        })}
      />
    )
    expect(screen.queryByTestId("capability-never-reported")).not.toBeInTheDocument()
    expect(screen.getByText("Not available")).toBeInTheDocument()
  })

  it("separates host execution features from proxy features", () => {
    render(
      <CapabilitiesSection
        row={row({
          kind: "remote-host",
          capabilitiesReportedAt: 1,
          capabilities: [
            cell({ id: "workflow.execution", group: "host-execution", source: "host-manifest" }),
            cell({ id: "browser.remote", group: "host-proxy", source: "host-manifest" }),
          ],
        })}
      />
    )
    const execution = screen.getByTestId("capability-group-host-execution")
    expect(within(execution).getByText("workflow.execution")).toBeInTheDocument()
    const proxy = screen.getByTestId("capability-group-host-proxy")
    expect(within(proxy).getByText("browser.remote")).toBeInTheDocument()
  })

  it("shows a host feature's version and operations", () => {
    render(
      <CapabilitiesSection
        row={row({
          kind: "remote-host",
          capabilitiesReportedAt: 1,
          capabilities: [
            cell({
              id: "workflow.execution",
              group: "host-execution",
              source: "host-manifest",
              detail: "v1 · run, cancel",
            }),
          ],
        })}
      />
    )
    expect(screen.getByText("v1 · run, cancel")).toBeInTheDocument()
  })

  /**
   * The fraction appears twice on purpose — once on the card header for the
   * whole matrix, once per group — so the reader gets the answer without
   * having to add the groups up. With one group the two agree, which is what
   * this pins: a card total computed from a different set than the rows would
   * be worse than no total at all.
   */
  it("states the count once when there is only one group", () => {
    render(
      <CapabilitiesSection
        row={row({
          capabilitiesReportedAt: 1,
          capabilities: [cell({ id: "a" }), cell({ id: "b", state: "absent" })],
        })}
      />
    )
    // The card header owns it; repeating it on the lone group below reads as
    // a duplicated element rather than as a total.
    expect(screen.getAllByText("1/2 reported")).toHaveLength(1)
  })

  it("totals the card header across every group", () => {
    render(
      <CapabilitiesSection
        row={row({
          capabilitiesReportedAt: 1,
          capabilities: [
            cell({ id: "a" }),
            cell({ id: "b", state: "absent" }),
            cell({ id: "workflow.execution", group: "host-execution" }),
          ],
        })}
      />
    )
    // 2 of 3 overall; neither group on its own says that.
    expect(screen.getByText("2/3 reported")).toBeInTheDocument()
    // With more than one group, each group states its own share too.
    expect(screen.getByText("1/2 reported")).toBeInTheDocument()
    expect(screen.getByText("1/1 reported")).toBeInTheDocument()
  })

  /**
   * A worker's ids are SecurityStore capabilities, a different vocabulary from
   * platform capabilities — rendering them here would read them wrong.
   */
  it("says why a worker has no matrix rather than showing an empty one", () => {
    render(<CapabilitiesSection row={row({ kind: "worker", capabilities: [] })} />)
    expect(screen.getByText("No capability vocabulary for this device")).toBeInTheDocument()
    expect(screen.getByText(/different vocabulary/)).toBeInTheDocument()
  })
})

/**
 * `source` was computed for every cell from the start and rendered nowhere,
 * which is what made ADR-0143's central distinction unreadable: `expected`
 * from a platform baseline and `reported` from the device are different kinds
 * of claim, and the cell said only which one it was, never who said it.
 */
describe("CapabilitiesSection — where each answer came from", () => {
  it("names the source beside every cell", () => {
    const { container } = render(
      <CapabilitiesSection
        row={row({
          capabilities: [
            cell({ id: "camera", state: "reported", source: "device-report" }),
            cell({ id: "shell", state: "expected", source: "platform-baseline" }),
          ],
        })}
      />
    )
    const sources = container.querySelectorAll('[data-testid^="capability-source-"]')
    expect(sources.length).toBe(2)
    expect([...sources].map((node) => node.textContent)).toEqual([
      "platform baseline",
      "device said so",
    ])
  })

  /**
   * The visible token needs room the narrowest pane does not have, and a fact
   * this load-bearing must not be reachable only on a wide monitor.
   */
  it("carries the source in the row title at every width", () => {
    const { container } = render(
      <CapabilitiesSection
        row={row({
          capabilities: [cell({ id: "camera", state: "reported", source: "device-report" })],
        })}
      />
    )
    const rows = container.querySelectorAll('li[data-testid^="capability-"]')
    expect(rows.length).toBeGreaterThan(0)
    for (const cell of rows) expect(cell.getAttribute("title")).toBeTruthy()
  })
})
