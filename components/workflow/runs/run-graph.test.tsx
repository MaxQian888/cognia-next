/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import { RunGraph } from "./run-graph"
import type { VisualWorkflow } from "@/types/workflow/visual"
type FlowProps = {
  nodes: Array<{
    id: string
    position: { x: number; y: number }
    data: { label: import("react").ReactNode }
  }>
  edges: Array<{ source: string; target: string }>
  nodesDraggable: boolean
  onNodeClick: (event: unknown, node: { id: string }) => void
}
let flowProps: FlowProps
jest.mock("@xyflow/react", () => ({
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Right: "right", Left: "left" },
  Background: () => null,
  Controls: () => null,
  ReactFlow: (props: FlowProps) => {
    flowProps = props
    return (
      <div>
        {props.nodes.map((node) => (
          <button key={node.id} onClick={() => props.onNodeClick({}, node)}>
            {node.data.label}
          </button>
        ))}
      </div>
    )
  },
}))
const workflow = {
  id: "wf",
  nodes: ["read", "left", "right"].map((id, i) => ({
    id,
    type: "ai.prompt",
    typeVersion: 1,
    position: { x: i * 200, y: 0 },
    data: { label: id, params: {} },
  })),
  edges: [
    { id: "a", source: "read", target: "left" },
    { id: "b", source: "read", target: "right" },
  ],
} as VisualWorkflow
it("preserves branch topology, shows states and duration, and selects a node", () => {
  const select = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RunGraph
        workflow={workflow}
        startedAt={100}
        completedAt={2100}
        selectedStepId="read"
        onSelectStep={select}
        events={[
          { id: "e", runId: "run", stepId: "read", ts: 100, type: "step_started" },
          { id: "f", runId: "run", stepId: "read", ts: 2100, type: "step_completed" },
        ]}
      />
    </NextIntlClientProvider>
  )
  expect(screen.getByText("Completed", { exact: false })).toHaveTextContent("2.00 s")
  expect(screen.getAllByText("Pending")).toHaveLength(2)
  fireEvent.click(screen.getByRole("button", { name: /left/ }))
  expect(select).toHaveBeenCalledWith("left")
  expect(flowProps.edges.map(({ source, target }) => [source, target])).toEqual([
    ["read", "left"],
    ["read", "right"],
  ])
  expect(flowProps.nodes[1].position).toEqual({ x: 200, y: 0 })
  expect(flowProps.nodesDraggable).toBe(false)
})
