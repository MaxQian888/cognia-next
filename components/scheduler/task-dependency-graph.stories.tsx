import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskDependencyGraph } from "./task-dependency-graph"
import type { DependencyGraph } from "@/types/scheduler/dependency"

// `TaskDependencyGraph` is pure: it lays out a `DependencyGraph` into
// deterministic topological columns and draws cubic-bezier SVG edges (no DOM
// measurement). Stories supply hand-built graphs to cover the empty state, a
// clean multi-level DAG, a focused node, and a cycle (which surfaces the red
// warning banner + red edges/nodes).
const meta = {
  title: "Scheduler/TaskDependencyGraph",
  component: TaskDependencyGraph,
  parameters: { layout: "padded" },
  args: {
    onSelectTask: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] overflow-x-auto rounded-md border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskDependencyGraph>

export default meta
type Story = StoryObj<typeof meta>

// A diamond DAG: ingest → (transform, validate) → publish.
const diamond: DependencyGraph = {
  nodes: [
    { id: "ingest", name: "Ingest data", type: "sync", status: "active", level: 0, inCycle: false },
    {
      id: "transform",
      name: "Transform rows",
      type: "workflow",
      status: "active",
      level: 1,
      inCycle: false,
    },
    {
      id: "validate",
      name: "Validate schema",
      type: "test",
      status: "active",
      level: 1,
      inCycle: false,
    },
    {
      id: "publish",
      name: "Publish digest",
      type: "chat",
      status: "active",
      level: 2,
      inCycle: false,
    },
  ],
  edges: [
    { from: "ingest", to: "transform", inCycle: false },
    { from: "ingest", to: "validate", inCycle: false },
    { from: "transform", to: "publish", inCycle: false },
    { from: "validate", to: "publish", inCycle: false },
  ],
  levelCount: 3,
  cycleNodeIds: [],
  hasCycle: false,
}

export const Dag: Story = {
  args: { graph: diamond },
}

// Same DAG with one node highlighted (the open detail view's task).
export const FocusedNode: Story = {
  args: { graph: diamond, focusTaskId: "transform" },
}

// A single isolated node — minimal one-column layout.
export const SingleNode: Story = {
  args: {
    graph: {
      nodes: [
        {
          id: "solo",
          name: "Standalone task",
          type: "chat",
          status: "active",
          level: 0,
          inCycle: false,
        },
      ],
      edges: [],
      levelCount: 1,
      cycleNodeIds: [],
      hasCycle: false,
    },
  },
}

// A two-node cycle → red warning banner, red edges, and red node borders.
export const WithCycle: Story = {
  args: {
    graph: {
      nodes: [
        { id: "a", name: "Task A", type: "agent", status: "active", level: 0, inCycle: true },
        { id: "b", name: "Task B", type: "agent", status: "paused", level: 1, inCycle: true },
      ],
      edges: [
        { from: "a", to: "b", inCycle: true },
        { from: "b", to: "a", inCycle: true },
      ],
      levelCount: 2,
      cycleNodeIds: ["a", "b"],
      hasCycle: true,
    },
  },
}

// No nodes → the empty placeholder text.
export const Empty: Story = {
  args: {
    graph: {
      nodes: [],
      edges: [],
      levelCount: 0,
      cycleNodeIds: [],
      hasCycle: false,
    },
  },
}
