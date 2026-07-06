import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowGraphViewer } from "./workflow-graph-viewer"

// Read-only vertical node list that topo-sorts the graph so the visual order
// matches execution order. Pure — it takes a `{ nodes, edges }` graph.
const meta = {
  title: "Mobile/Workflow/WorkflowGraphViewer",
  component: WorkflowGraphViewer,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowGraphViewer>

export default meta
type Story = StoryObj<typeof meta>

export const Linear: Story = {
  args: {
    graph: {
      nodes: [
        { id: "t", label: "When triggered", kind: "trigger.manual" },
        { id: "s", label: "Summarize thread", kind: "ai.agent.turn", description: "Condense to 5 bullets." },
        { id: "r", label: "Send reply", kind: "action.character.send" },
      ],
      edges: [
        { from: "t", to: "s" },
        { from: "s", to: "r" },
      ],
    },
  },
}

export const Branching: Story = {
  args: {
    graph: {
      nodes: [
        { id: "t", label: "On new message", kind: "trigger.connector" },
        { id: "sw", label: "Route by intent", kind: "flow.switch" },
        { id: "a", label: "Auto-reply", kind: "action.character.send" },
        { id: "b", label: "Escalate", kind: "io.http.request" },
        { id: "log", label: "Append to log", kind: "data.transform" },
      ],
      edges: [
        { from: "t", to: "sw" },
        { from: "sw", to: "a" },
        { from: "sw", to: "b" },
        { from: "a", to: "log" },
        { from: "b", to: "log" },
      ],
    },
  },
}

export const Empty: Story = {
  args: { graph: { nodes: [], edges: [] } },
}
