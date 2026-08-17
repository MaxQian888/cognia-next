/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { PI_PACKAGE_CATALOG, type PiCatalogEntry } from "@/lib/pi-packages/catalog"
import { detectPiOverlaps, type PiOverlapConflict } from "@/lib/pi-packages/conflicts"
import messages from "@/i18n/messages/en.json"
import { PiOverlapGraph, buildPiOverlapGraph } from "./pi-overlap-graph"

// React Flow measures the DOM; jsdom reports zero-size boxes, which makes it log
// a resize warning. The graph's meaning is in `buildPiOverlapGraph`, which is
// pure and asserted directly, so the canvas itself is stubbed away here.
jest.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes }: { nodes: Array<{ id: string }> }) => (
    <div data-testid="rf-canvas" data-node-count={nodes.length} />
  ),
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
}))

const entry = (id: string): PiCatalogEntry => {
  const found = PI_PACKAGE_CATALOG.find((e) => e.id === id)
  if (!found) throw new Error(`no catalog entry ${id}`)
  return found
}

const labels = { group: (group: string) => `GROUP:${group}` }

function renderGraph(conflicts: readonly PiOverlapConflict[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PiOverlapGraph conflicts={conflicts} />
    </NextIntlClientProvider>
  )
}

describe("buildPiOverlapGraph", () => {
  it("is empty for no conflicts", () => {
    const model = buildPiOverlapGraph([], labels)
    expect(model.nodes).toEqual([])
    expect(model.edges).toEqual([])
    expect(model.height).toBe(0)
  })

  it("builds one hub per group plus one leaf per package", () => {
    const model = buildPiOverlapGraph(
      [{ group: "memory", entries: [entry("pi-memory"), entry("vtstech-pi-long-term-memory")] }],
      labels
    )
    expect(model.nodes).toHaveLength(3)
    expect(model.nodes[0].id).toBe("group:memory")
    expect(model.nodes[0].data.label).toBe("GROUP:memory")
    expect(model.edges).toHaveLength(2)
    expect(model.edges.every((e) => e.source === "group:memory")).toBe(true)
  })

  /** Same input must give the same picture, or the graph churns on re-render. */
  it("is deterministic", () => {
    const conflicts = [
      { group: "memory" as const, entries: [entry("pi-memory"), entry("pi-memory")] },
    ]
    expect(buildPiOverlapGraph(conflicts, labels)).toEqual(buildPiOverlapGraph(conflicts, labels))
  })

  it("separates clusters vertically so two groups never overlap", () => {
    const model = buildPiOverlapGraph(
      [
        { group: "footer", entries: [entry("narumitw-pi-statusline"), entry("pi-atelier")] },
        { group: "memory", entries: [entry("pi-memory"), entry("vtstech-pi-long-term-memory")] },
      ],
      labels
    )
    const footerHub = model.nodes.find((n) => n.id === "group:footer")!
    const memoryHub = model.nodes.find((n) => n.id === "group:memory")!
    expect(memoryHub.position.y).toBeGreaterThan(footerHub.position.y)
  })

  it("gives the hub and its leaves different columns", () => {
    const model = buildPiOverlapGraph(
      [{ group: "memory", entries: [entry("pi-memory"), entry("vtstech-pi-long-term-memory")] }],
      labels
    )
    const hub = model.nodes.find((n) => n.id === "group:memory")!
    const leaves = model.nodes.filter((n) => n.id !== "group:memory")
    for (const leaf of leaves) expect(leaf.position.x).toBeGreaterThan(hub.position.x)
  })

  /** The arrangement carries the meaning, so a user must not be able to scramble it. */
  it("makes every node non-draggable and non-selectable", () => {
    const model = buildPiOverlapGraph(
      [{ group: "memory", entries: [entry("pi-memory"), entry("vtstech-pi-long-term-memory")] }],
      labels
    )
    for (const node of model.nodes) {
      expect(node.draggable).toBe(false)
      expect(node.selectable).toBe(false)
    }
  })

  it("labels leaves by short name, keeping the scope so forks stay distinct", () => {
    const model = buildPiOverlapGraph(
      [
        {
          group: "subagents",
          entries: [entry("narumitw-pi-subagents"), entry("gotgenes-pi-subagents")],
        },
      ],
      labels
    )
    const leafLabels = model.nodes
      .filter((n) => n.id !== "group:subagents")
      .map((n) => n.data.label)
    expect(leafLabels).toEqual(["@narumitw/pi-subagents", "@gotgenes/pi-subagents"])
  })
})

describe("PiOverlapGraph", () => {
  it("says so plainly when nothing overlaps", () => {
    renderGraph([])
    expect(screen.getByTestId("pi-overlap-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("rf-canvas")).not.toBeInTheDocument()
  })

  it("renders the canvas and a per-group summary when there is a conflict", () => {
    renderGraph(detectPiOverlaps(["npm:pi-memory@0.4.2", "npm:@vtstech/pi-long-term-memory@1.3.5"]))
    expect(screen.getByTestId("rf-canvas")).toHaveAttribute("data-node-count", "3")
    expect(screen.getByText(/2 packages both occupy/i)).toBeInTheDocument()
  })

  /** The point of the panel: Pi itself never warns, so this is the only notice. */
  it("surfaces every contested group, not just the first", () => {
    renderGraph(
      detectPiOverlaps([
        "npm:pi-memory@0.4.2",
        "npm:@vtstech/pi-long-term-memory@1.3.5",
        "npm:@narumitw/pi-statusline@0.49.6",
        "npm:pi-atelier@0.8.1",
      ])
    )
    expect(screen.getAllByText(/both occupy/i).length).toBeGreaterThanOrEqual(2)
  })
})
