/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { WorkflowGraphViewer } from "./workflow-graph-viewer"

describe("<WorkflowGraphViewer />", () => {
  it("renders the empty state when no nodes exist", () => {
    render(<WorkflowGraphViewer graph={{ nodes: [], edges: [] }} />)
    // Mocked next-intl resolves to mobile.workflow.graphViewerEmpty
    expect(screen.getByText(/no nodes in this workflow/i)).toBeInTheDocument()
  })

  it("renders nodes in topo-sorted order following edges", () => {
    render(
      <WorkflowGraphViewer
        graph={{
          // Input order intentionally reverses topo order.
          nodes: [
            { id: "c", label: "Cee" },
            { id: "a", label: "Ay" },
            { id: "b", label: "Bee" },
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "c" },
          ],
        }}
      />
    )

    const rendered = screen.getAllByTestId(/^workflow-node-/)
    expect(rendered.map((n) => n.getAttribute("data-testid"))).toEqual([
      "workflow-node-a",
      "workflow-node-b",
      "workflow-node-c",
    ])
  })

  it("renders the kind badge with a category-coloured class", () => {
    render(
      <WorkflowGraphViewer
        graph={{
          nodes: [
            { id: "t", kind: "trigger.cron", label: "Cron trigger" },
            { id: "a", kind: "action.character.send", label: "Send" },
            { id: "f", kind: "flow.switch" },
            { id: "d", kind: "data.transform" },
            { id: "i", kind: "io.http" },
            { id: "ai", kind: "ai.generate" },
            { id: "unk", kind: "custom.unknown" },
          ],
          edges: [],
        }}
      />
    )
    expect(screen.getByText("trigger.cron").className).toContain("emerald")
    expect(screen.getByText("action.character.send").className).toContain("blue")
    expect(screen.getByText("flow.switch").className).toContain("amber")
    expect(screen.getByText("data.transform").className).toContain("rose")
    expect(screen.getByText("io.http").className).toContain("cyan")
    expect(screen.getByText("ai.generate").className).toContain("violet")
    // Unknown kind: no colour class.
    expect(screen.getByText("custom.unknown").className).not.toMatch(
      /emerald|blue|amber|rose|cyan|violet/
    )
  })

  it("falls back to source order when the graph has a cycle", () => {
    render(
      <WorkflowGraphViewer
        graph={{
          nodes: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" },
          ],
          edges: [
            { from: "x", to: "y" },
            { from: "y", to: "x" },
          ],
        }}
      />
    )
    const rendered = screen.getAllByTestId(/^workflow-node-/)
    expect(rendered.map((n) => n.getAttribute("data-testid"))).toEqual([
      "workflow-node-x",
      "workflow-node-y",
    ])
  })

  it("renders the optional description line when present", () => {
    render(
      <WorkflowGraphViewer
        graph={{
          nodes: [{ id: "n", label: "Node", description: "A descriptive line" }],
          edges: [],
        }}
      />
    )
    expect(screen.getByText("A descriptive line")).toBeInTheDocument()
  })

  it("falls back to the node id when label is omitted", () => {
    render(<WorkflowGraphViewer graph={{ nodes: [{ id: "raw-id" }], edges: [] }} />)
    expect(screen.getByText("raw-id")).toBeInTheDocument()
  })

  it("ignores edges that reference missing node ids", () => {
    render(
      <WorkflowGraphViewer
        graph={{
          nodes: [{ id: "a" }],
          edges: [{ from: "ghost", to: "a" }],
        }}
      />
    )
    expect(screen.getByTestId("workflow-node-a")).toBeInTheDocument()
  })
})
