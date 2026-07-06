import { matchWorkflows, handleRunWorkflow } from "./run-saved-workflow"
import type { WorkflowRow } from "@/types/workflow/visual"
import type { SlashContext } from "../builtin"

const listWorkflows = jest.fn<Promise<WorkflowRow[]>, []>()
const runWorkflow = jest.fn((..._a: unknown[]) =>
  Promise.resolve({ runId: "r1", status: "succeeded" as const })
)

jest.mock("@/lib/db/workflows", () => ({
  listWorkflows: () => listWorkflows(),
}))
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflow(...a),
}))

function wf(id: string, name: string, nodes = 1): WorkflowRow {
  return {
    id,
    name,
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
    edges: [],
  } as unknown as WorkflowRow
}

function makeCtx(args: string, chatStatus: SlashContext["chatStatus"] = "idle"): SlashContext {
  return {
    args,
    activeSessionId: "s1",
    chatStatus,
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings: jest.fn(),
    setPermissionMode: jest.fn(),
    pushSystemMessage: jest.fn(),
  }
}

beforeEach(() => {
  listWorkflows.mockReset()
  runWorkflow.mockClear()
})

describe("matchWorkflows", () => {
  const list = [wf("id-1", "Daily Report"), wf("id-2", "Daily Digest"), wf("id-3", "Cleanup")]
  it("matches by exact id", () => {
    expect(matchWorkflows(list, "id-2").map((w) => w.id)).toEqual(["id-2"])
  })
  it("matches by exact name (case-insensitive) over substring", () => {
    expect(matchWorkflows(list, "cleanup").map((w) => w.id)).toEqual(["id-3"])
  })
  it("falls back to name substring (possibly multiple)", () => {
    expect(matchWorkflows(list, "daily").map((w) => w.id)).toEqual(["id-1", "id-2"])
  })
  it("returns empty for blank query", () => {
    expect(matchWorkflows(list, "  ")).toEqual([])
  })
})

describe("handleRunWorkflow", () => {
  it("lists workflows when no argument is given", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report")])
    const ctx = makeCtx("")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("Daily Report")
  })

  it("reports no match", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report")])
    const ctx = makeCtx("nope")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("No workflow matches")
  })

  it("reports ambiguity for multiple matches", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report"), wf("id-2", "Daily Digest")])
    const ctx = makeCtx("daily")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).not.toHaveBeenCalled()
    expect((ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]).toContain("ambiguous")
  })

  it("runs a unique match with source 'chat' and pushes a result chip", async () => {
    listWorkflows.mockResolvedValue([wf("id-1", "Daily Report")])
    const ctx = makeCtx("Daily Report")
    await handleRunWorkflow(ctx)
    expect(runWorkflow).toHaveBeenCalledTimes(1)
    const arg = runWorkflow.mock.calls[0][0] as unknown as { triggeredBy: { source: string } }
    expect(arg.triggeredBy.source).toBe("chat")
    const chip = (ctx.pushSystemMessage as jest.Mock).mock.calls[0][0]
    expect(chip).toMatchObject({ kind: "slash-result", commandId: "workflow" })
  })

  it("refuses while a turn is streaming", async () => {
    const ctx = makeCtx("Daily Report", "streaming")
    await handleRunWorkflow(ctx)
    expect(listWorkflows).not.toHaveBeenCalled()
    expect(runWorkflow).not.toHaveBeenCalled()
  })
})
