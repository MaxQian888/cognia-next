/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TaskDependencyGraph } from "./task-dependency-graph"
import type { DependencyGraph } from "@/types/scheduler/dependency"

const chain: DependencyGraph = {
  nodes: [
    { id: "a", name: "A", type: "chat", status: "active", level: 0, inCycle: false },
    { id: "b", name: "B", type: "chat", status: "active", level: 1, inCycle: false },
    { id: "c", name: "C", type: "chat", status: "active", level: 2, inCycle: false },
  ],
  edges: [
    { from: "a", to: "b", inCycle: false },
    { from: "b", to: "c", inCycle: false },
  ],
  levelCount: 3,
  cycleNodeIds: [],
  hasCycle: false,
}

const cyclic: DependencyGraph = {
  nodes: [
    { id: "x", name: "X", type: "chat", status: "active", level: 0, inCycle: true },
    { id: "y", name: "Y", type: "chat", status: "active", level: 0, inCycle: true },
  ],
  edges: [
    { from: "x", to: "y", inCycle: true },
    { from: "y", to: "x", inCycle: true },
  ],
  levelCount: 1,
  cycleNodeIds: ["x", "y"],
  hasCycle: true,
}

const empty: DependencyGraph = {
  nodes: [],
  edges: [],
  levelCount: 0,
  cycleNodeIds: [],
  hasCycle: false,
}

describe("TaskDependencyGraph", () => {
  it("renders a node per graph node and an edge per graph edge", () => {
    render(<TaskDependencyGraph graph={chain} onSelectTask={jest.fn()} />)
    expect(screen.getByTestId("dependency-node-a")).toBeInTheDocument()
    expect(screen.getByTestId("dependency-node-b")).toBeInTheDocument()
    expect(screen.getByTestId("dependency-node-c")).toBeInTheDocument()
    expect(screen.getByTestId("dependency-edge-a-b")).toBeInTheDocument()
    expect(screen.getByTestId("dependency-edge-b-c")).toBeInTheDocument()
  })

  it("dispatches onSelectTask when a node is clicked", () => {
    const onSelectTask = jest.fn()
    render(<TaskDependencyGraph graph={chain} onSelectTask={onSelectTask} />)
    fireEvent.click(screen.getByTestId("dependency-node-b"))
    expect(onSelectTask).toHaveBeenCalledWith("b")
  })

  it("shows a cycle warning and red edges when the graph has a cycle", () => {
    render(<TaskDependencyGraph graph={cyclic} onSelectTask={jest.fn()} />)
    expect(screen.getByTestId("dependency-cycle-warning")).toBeInTheDocument()
    const edge = screen.getByTestId("dependency-edge-x-y")
    expect(edge.getAttribute("class") ?? "").toContain("stroke-red-500")
  })

  it("renders the empty state when the graph has no nodes", () => {
    render(<TaskDependencyGraph graph={empty} onSelectTask={jest.fn()} />)
    expect(screen.getByTestId("dependency-graph-empty")).toBeInTheDocument()
  })
})
