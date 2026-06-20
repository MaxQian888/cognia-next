import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import type { VisualWorkflow, WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import { applyEnhancement, buildExecutionPage, buildSourceDigest } from "./index"
import type { ExecutionPageLabels, ExecutionPageSource } from "./types"

const labels: ExecutionPageLabels = {
  status: "Status",
  trigger: "Trigger",
  duration: "Duration",
  tokens: "Tokens",
  cost: "Cost",
  steps: "Steps",
  succeeded: "Succeeded",
  failed: "Failed",
  stepBreakdown: "Step breakdown",
  stepDuration: "Step duration",
  tokenBurn: "Token burn",
  outputs: "Outputs",
  error: "Error",
  model: "Model",
  messages: "Messages",
  user: "User",
  assistant: "Assistant",
  toolCalls: "Tool calls",
  turns: "Turns",
  turn: "Turn",
  role: "Role",
  preview: "Preview",
  finalOutput: "Final output",
  summary: "AI Summary",
  insights: "Insights",
  untitled: "Untitled",
  unknown: "Unknown",
}

const workflow = {
  id: "wf1",
  schemaVersion: 2,
  name: "WF",
  createdAt: 0,
  updatedAt: 0,
  edges: [],
  settings: {},
  nodes: [
    {
      id: "n1",
      type: "action.code",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Step One" },
    },
  ],
} as unknown as VisualWorkflow

const run = {
  id: "run1",
  workflowId: "wf1",
  status: "succeeded",
  triggerKind: "trigger.manual",
  triggerPayload: {},
  startedAt: 0,
  completedAt: 1000,
  workflowSnapshot: workflow,
  output: "final text",
} as unknown as WorkflowRunRow

const events = [
  { id: "e1", runId: "run1", ts: 0, type: "step_started", stepId: "n1" },
  {
    id: "e2",
    runId: "run1",
    ts: 500,
    type: "step_completed",
    stepId: "n1",
    payload: { output: "x" },
  },
] as unknown as WorkflowRunEventRow[]

const session = {
  id: "s1",
  title: "Chat",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
} as unknown as ChatSession
const messages = [
  { id: "m1", sessionId: "s1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
  {
    id: "m2",
    sessionId: "s1",
    role: "assistant",
    parts: [{ type: "text", text: "hello there" }],
    createdAt: 0,
  },
] as unknown as StoredMessage[]

const wfSource: ExecutionPageSource = { kind: "workflow-run", run, events }
const convoSource: ExecutionPageSource = { kind: "conversation", session, messages }

describe("buildExecutionPage", () => {
  it("dispatches to the workflow-run projector", () => {
    expect(buildExecutionPage(wfSource, labels).id).toBe("wfrun-page-run1")
  })
  it("dispatches to the conversation projector", () => {
    expect(buildExecutionPage(convoSource, labels).id).toBe("convo-page-s1")
  })
})

describe("buildSourceDigest", () => {
  it("summarizes a workflow run with node labels and status", () => {
    const digest = buildSourceDigest(wfSource, labels)
    expect(digest).toContain("Status: succeeded")
    expect(digest).toContain("Step One")
    expect(digest).toContain("output: final text")
  })
  it("summarizes a conversation with role-prefixed previews and skips empty turns", () => {
    const withEmpty = [
      ...messages,
      {
        id: "m3",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "tool-bash" }],
        createdAt: 0,
      },
    ] as unknown as StoredMessage[]
    const digest = buildSourceDigest({ kind: "conversation", session, messages: withEmpty }, labels)
    expect(digest).toContain("Chat")
    expect(digest).toContain("user: hi")
    expect(digest).toContain("assistant: hello there")
    // the tool-only turn contributes no text line
    expect(digest.split("\n").filter((l) => l.startsWith("assistant:"))).toHaveLength(1)
  })

  it("includes the error line and falls back to node id when a node has no label", () => {
    const noLabelWorkflow = {
      ...workflow,
      nodes: [
        { id: "bare", type: "action.code", typeVersion: 1, position: { x: 0, y: 0 }, data: {} },
      ],
    } as unknown as VisualWorkflow
    const failed = {
      ...run,
      status: "failed",
      error: { message: "kaboom" },
      output: undefined,
      workflowSnapshot: noLabelWorkflow,
    } as unknown as WorkflowRunRow
    const digest = buildSourceDigest({ kind: "workflow-run", run: failed, events }, labels)
    expect(digest).toContain("Error: kaboom")
    expect(digest).toContain("- bare (action.code)")
    expect(digest).not.toContain("output:")
  })

  it("uses the untitled label when a conversation has no title", () => {
    const untitled = { ...session, title: undefined } as unknown as ChatSession
    const digest = buildSourceDigest({ kind: "conversation", session: untitled, messages }, labels)
    expect(digest.split("\n")[0]).toBe("Untitled")
  })
})

describe("applyEnhancement", () => {
  it("prepends a summary card and rewires the root, without mutating input", () => {
    const app = buildExecutionPage(wfSource, labels)
    const originalRootChildren = [
      ...(app.components.find((c) => c.id === "root") as { children: string[] }).children,
    ]

    const enhanced = applyEnhancement(
      app,
      { title: "Better Title", summary: "It worked.", insights: ["fast"] },
      labels
    )

    // input untouched
    expect(app.name).toBe("WF")
    expect(
      (app.components.find((c) => c.id === "root") as { children: string[] }).children
    ).toEqual(originalRootChildren)

    // output: title applied, summary card first in root
    expect(enhanced.name).toBe("Better Title")
    const newRoot = enhanced.components.find((c) => c.id === "root") as { children: string[] }
    expect(newRoot.children[0]).toBe("aisum-card")
    expect(newRoot.children.slice(1)).toEqual(originalRootChildren)

    const card = enhanced.components.find((c) => c.id === "aisum-card") as {
      title: string
      children: string[]
    }
    expect(card.title).toBe("AI Summary")
    expect(card.children).toEqual(["aisum-summary", "aisum-insights"])

    // messages regenerated to embed the new tree
    const update = enhanced.messages.find((m) => m.type === "updateComponents") as {
      components: unknown[]
    }
    expect(update.components).toBe(enhanced.components)
  })

  it("omits the insights list when there are none and keeps the original name", () => {
    const app = buildExecutionPage(convoSource, labels)
    const enhanced = applyEnhancement(app, { summary: "Short.", insights: [] }, labels)
    expect(enhanced.name).toBe("Chat")
    const card = enhanced.components.find((c) => c.id === "aisum-card") as { children: string[] }
    expect(card.children).toEqual(["aisum-summary"])
    expect(enhanced.components.find((c) => c.id === "aisum-insights")).toBeUndefined()
  })
})
