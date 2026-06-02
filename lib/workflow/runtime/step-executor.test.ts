/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { runStep, type RunStepInput } from "./step-executor"
import { registerNodeExecutor } from "@/lib/workflow/nodes/registry"
import { IdempotencyCache } from "./idempotency"
import { createRunLogger, listRunEvents } from "./event-log"
import { NoopSecretResolver } from "./secret-resolver"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type TriggerEvent,
  type VisualWorkflow,
  type WorkflowNode,
} from "@/types/workflow/visual"

const execSpy = jest.fn(async () => ({ output: { real: true } }))

// Register once for this isolated module registry. Cast because the test kind
// reuses a real union member but supplies its own spy executor.
registerNodeExecutor({ kind: "data.code", typeVersion: 1, execute: execSpy })

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  execSpy.mockClear()
})

const node: WorkflowNode = {
  id: "n1",
  type: "data.code",
  typeVersion: 1,
  position: { x: 0, y: 0 },
  data: { label: "n1", params: {} },
}

function makeWorkflow(pinData?: Record<string, unknown>): VisualWorkflow {
  return {
    id: "wf",
    schemaVersion: 1,
    name: "t",
    createdAt: 0,
    updatedAt: 0,
    nodes: [node],
    edges: [],
    settings: DEFAULT_WORKFLOW_SETTINGS,
    ...(pinData ? { pinData } : {}),
  }
}

const trigger: TriggerEvent = { workflowId: "wf", kind: "trigger.manual", payload: {}, originAt: 0 }

async function buildInput(opts: {
  honorPinData?: boolean
  pinData?: Record<string, unknown>
}): Promise<RunStepInput> {
  const runId = "run_1"
  return {
    workflow: makeWorkflow(opts.pinData),
    node,
    trigger,
    upstream: {},
    runId,
    signal: new AbortController().signal,
    cache: await IdempotencyCache.hydrate(runId),
    retryPolicy: DEFAULT_WORKFLOW_SETTINGS.retryDefaults,
    secretResolver: NoopSecretResolver,
    logger: createRunLogger(runId),
    honorPinData: opts.honorPinData,
  }
}

describe("runStep pin short-circuit", () => {
  it("returns the pinned value WITHOUT invoking the executor when honorPinData is true", async () => {
    const input = await buildInput({ honorPinData: true, pinData: { n1: { pinned: 1 } } })
    const result = await runStep(input)

    expect(execSpy).not.toHaveBeenCalled()
    expect(result.output).toEqual({ pinned: 1 })
    expect(result.fromCache).toBe(false)
    expect(input.cache.get("n1")).toEqual({ pinned: 1 })

    const events = await listRunEvents("run_1")
    expect(events.find((e) => e.type === "step_started")).toBeDefined()
    const completed = events.find((e) => e.type === "step_completed")
    expect((completed?.payload as { output?: unknown })?.output).toEqual({ pinned: 1 })
  })

  it("ignores pin data when honorPinData is falsy (production-style run)", async () => {
    const input = await buildInput({ pinData: { n1: { pinned: 1 } } })
    const result = await runStep(input)

    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(result.output).toEqual({ real: true })
  })

  it("runs the executor when honorPinData is true but the node has no pin", async () => {
    const input = await buildInput({ honorPinData: true, pinData: { otherNode: {} } })
    const result = await runStep(input)

    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(result.output).toEqual({ real: true })
  })
})
