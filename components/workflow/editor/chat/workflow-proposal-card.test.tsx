/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import {
  __resetRegistryForTesting,
  registerEditorStore,
} from "@/lib/workflow/editor/store-registry"
import { createEditorStore } from "@/lib/workflow/editor/store"
import {
  __resetProposalStoreForTesting,
  useProposalStore,
} from "@/lib/workflow/editor/proposal-store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import type { ProposalOp } from "@/lib/workflow/editor/proposal-types"
import { WorkflowProposalCard } from "./workflow-proposal-card"

function workflow(id: string): VisualWorkflow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
    },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

const sampleOps: ProposalOp[] = [
  { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
  {
    type: "add_node",
    nodeId: "n_b",
    kind: "ai.prompt",
    position: { x: 200, y: 0 },
    data: { params: { userPrompt: "hi" } },
  },
  { type: "connect_edge", edgeId: "e_ab", source: "n_a", target: "n_b" },
]

function makePart(
  payload: Record<string, unknown> | null,
  options: { state?: ToolUIPart["state"] } = {}
): ToolUIPart {
  return {
    type: "tool-wf_propose_batch",
    toolCallId: "call_1",
    state: options.state ?? "output-available",
    input: {},
    output: payload === null ? "" : JSON.stringify(payload),
  } as unknown as ToolUIPart
}

beforeEach(() => {
  __resetRegistryForTesting()
  __resetProposalStoreForTesting()
})

describe("WorkflowProposalCard — open status", () => {
  it("renders the summary + aggregate counts when a proposal is open", () => {
    useProposalStore.getState().openProposal("wf_a", {
      proposalId: "p_1",
      workflowId: "wf_a",
      summary: "Add a parallel pair of analysts",
      ops: sampleOps,
    })
    render(
      <WorkflowProposalCard
        part={makePart({
          ok: true,
          proposalId: "p_1",
          workflowId: "wf_a",
          summary: "Add a parallel pair of analysts",
          opCount: { add: 2, remove: 0, connect: 1, disconnect: 0, configure: 0 },
        })}
      />
    )
    expect(screen.getByTestId("workflow-proposal-summary")).toHaveTextContent(
      "Add a parallel pair of analysts"
    )
    const aggregate = screen.getByTestId("workflow-proposal-aggregate")
    expect(aggregate.textContent).toContain("+2 nodes")
    expect(aggregate.textContent).toContain("+1 edges")
    expect(screen.getByTestId("workflow-proposal-apply")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-proposal-discard")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-proposal-status")).toHaveTextContent("Pending")
  })

  it("toggles the op list when the user expands it", () => {
    useProposalStore.getState().openProposal("wf_a", {
      proposalId: "p_1",
      workflowId: "wf_a",
      summary: "x",
      ops: sampleOps,
    })
    render(
      <WorkflowProposalCard
        part={makePart({
          ok: true,
          proposalId: "p_1",
          workflowId: "wf_a",
          summary: "x",
          opCount: { add: 2, remove: 0, connect: 1, disconnect: 0, configure: 0 },
        })}
      />
    )
    expect(screen.queryByTestId("workflow-proposal-op-list")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workflow-proposal-toggle"))
    expect(screen.getByTestId("workflow-proposal-op-list")).toBeInTheDocument()
    // The list should mention the node ids.
    expect(screen.getByTestId("workflow-proposal-op-list").textContent).toContain("n_a")
    expect(screen.getByTestId("workflow-proposal-op-list").textContent).toContain("n_b")
  })

  it("returns null when output is empty / unparseable", () => {
    const { container } = render(<WorkflowProposalCard part={makePart(null)} />)
    expect(container.firstChild).toBeNull()
  })

  it("returns null when the tool returned ok:false", () => {
    const { container } = render(
      <WorkflowProposalCard
        part={makePart({ ok: false, error: { code: "boom", message: "no" } })}
      />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe("WorkflowProposalCard — Apply flow", () => {
  it("calls editor.applyProposalOps and transitions to 'applied' status", () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    useProposalStore.getState().openProposal("wf_a", {
      proposalId: "p_1",
      workflowId: "wf_a",
      summary: "x",
      ops: sampleOps,
    })
    render(
      <WorkflowProposalCard
        part={makePart({
          ok: true,
          proposalId: "p_1",
          workflowId: "wf_a",
          summary: "x",
          opCount: { add: 2, remove: 0, connect: 1, disconnect: 0, configure: 0 },
        })}
      />
    )
    act(() => {
      fireEvent.click(screen.getByTestId("workflow-proposal-apply"))
    })
    // Editor store mutated.
    expect(store.getState().nodes).toHaveLength(2)
    expect(store.getState().edges).toHaveLength(1)
    // Proposal store marked applied.
    expect(useProposalStore.getState().statusOf("p_1")).toBe("applied")
    // UI reflects the new status.
    expect(screen.getByTestId("workflow-proposal-status")).toHaveTextContent("Applied")
    // Apply / Discard buttons are gone once the proposal has been applied.
    expect(screen.queryByTestId("workflow-proposal-apply")).not.toBeInTheDocument()
  })

  it("surfaces firstError from the editor and does NOT mark applied", () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    useProposalStore.getState().openProposal("wf_a", {
      proposalId: "p_bad",
      workflowId: "wf_a",
      summary: "broken",
      ops: [
        {
          type: "connect_edge",
          edgeId: "e_ghost",
          source: "n_ghost",
          target: "n_ghost2",
        },
      ],
    })
    render(
      <WorkflowProposalCard
        part={makePart({
          ok: true,
          proposalId: "p_bad",
          workflowId: "wf_a",
          summary: "broken",
          opCount: { add: 0, remove: 0, connect: 1, disconnect: 0, configure: 0 },
        })}
      />
    )
    act(() => {
      fireEvent.click(screen.getByTestId("workflow-proposal-apply"))
    })
    expect(useProposalStore.getState().statusOf("p_bad")).toBe("open")
    expect(screen.getByTestId("workflow-proposal-error").textContent).toMatch(/n_ghost/)
  })

  it("returns the editor-not-open error when the workflow id has no registered editor", () => {
    useProposalStore.getState().openProposal("wf_unregistered", {
      proposalId: "p_x",
      workflowId: "wf_unregistered",
      summary: "x",
      ops: sampleOps,
    })
    render(
      <WorkflowProposalCard
        part={makePart({
          ok: true,
          proposalId: "p_x",
          workflowId: "wf_unregistered",
          summary: "x",
          opCount: { add: 2, remove: 0, connect: 1, disconnect: 0, configure: 0 },
        })}
      />
    )
    act(() => {
      fireEvent.click(screen.getByTestId("workflow-proposal-apply"))
    })
    expect(screen.getByTestId("workflow-proposal-error")).toBeInTheDocument()
  })
})

describe("WorkflowProposalCard — Discard flow", () => {
  it("transitions to 'discarded' and hides Apply/Discard buttons", () => {
    useProposalStore.getState().openProposal("wf_a", {
      proposalId: "p_1",
      workflowId: "wf_a",
      summary: "x",
      ops: sampleOps,
    })
    render(
      <WorkflowProposalCard
        part={makePart({
          ok: true,
          proposalId: "p_1",
          workflowId: "wf_a",
          summary: "x",
          opCount: { add: 2, remove: 0, connect: 1, disconnect: 0, configure: 0 },
        })}
      />
    )
    act(() => {
      fireEvent.click(screen.getByTestId("workflow-proposal-discard"))
    })
    expect(useProposalStore.getState().statusOf("p_1")).toBe("discarded")
    expect(screen.getByTestId("workflow-proposal-status")).toHaveTextContent("Discarded")
    expect(screen.queryByTestId("workflow-proposal-apply")).not.toBeInTheDocument()
  })
})
