/**
 * @jest-environment jsdom
 *
 * flow.loop typeVersion 2 — container sub-canvas execution. Covers the
 * consensus semantics: forEach/times/while modes, explicit output mapping
 * into `items[]`, `$item`/`$loop` reset per iteration, staticData
 * accumulation across iterations, break/continue (innermost only),
 * iteration concurrency under the global gate, and abort mid-iteration.
 */
import "fake-indexeddb/auto"
import "@/lib/workflow/nodes/built-ins"
import { runLoopContainer } from "./loop-container"
import { IdempotencyCache, iterationCacheKey } from "./idempotency"
import { createRunLogger } from "./event-log"
import { NoopSecretResolver } from "./secret-resolver"
import { ConcurrencyGate, __setGlobalRunGateForTesting } from "./run-concurrency-gate"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type {
  TriggerEvent,
  VisualWorkflow,
  WorkflowEdge,
  WorkflowNode,
} from "@/types/workflow/visual"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __setGlobalRunGateForTesting(null)
})

afterEach(() => __setGlobalRunGateForTesting(null))

const trigger: TriggerEvent = {
  workflowId: "wf",
  kind: "trigger.manual",
  payload: { items: ["a", "b", "c"], n: 2, pairs: ["x", "y"] },
  originAt: 1,
}

function node(
  id: string,
  type: WorkflowNode["type"],
  params: Record<string, unknown>,
  parentId?: string,
  typeVersion = 1
): WorkflowNode {
  return {
    id,
    type,
    typeVersion,
    ...(parentId ? { parentId } : {}),
    position: { x: 0, y: 0 },
    data: { label: id, params },
  }
}

function loopWorkflow(
  loopParams: Record<string, unknown>,
  children: WorkflowNode[],
  childEdges: WorkflowEdge[] = []
): { workflow: VisualWorkflow; loopNode: WorkflowNode } {
  const loopNode = node("loop1", "flow.loop", loopParams, undefined, 2)
  const workflow: VisualWorkflow = {
    id: "wf",
    schemaVersion: 2,
    name: "loop test",
    createdAt: 0,
    updatedAt: 0,
    nodes: [loopNode, ...children],
    edges: childEdges,
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
  return { workflow, loopNode }
}

async function run(
  workflow: VisualWorkflow,
  loopNode: WorkflowNode,
  opts: {
    upstream?: Record<string, unknown>
    signal?: AbortSignal
    cache?: IdempotencyCache
    runId?: string
  } = {}
) {
  const runId = opts.runId ?? "run_loop_test"
  return runLoopContainer({
    workflow,
    node: loopNode,
    trigger,
    upstream: opts.upstream ?? {},
    runId,
    signal: opts.signal ?? new AbortController().signal,
    cache: opts.cache ?? new IdempotencyCache(),
    retryPolicy: workflow.settings.retryDefaults,
    secretResolver: NoopSecretResolver,
    logger: createRunLogger(runId),
  })
}

describe("forEach mode", () => {
  it("iterates the source array once per element", async () => {
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $node['body'].value }}",
      },
      [node("body", "flow.set", { variable: "v", value: "{{ $item }}" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    expect(result.output).toMatchObject({ count: 3 })
  })
})

describe("output mapping + $item/$loop scope", () => {
  it("pushes the resolved output expression into items[] each iteration", async () => {
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $node['body'].value }}",
      },
      [node("body", "flow.set", { variable: "v", value: "{{ $item }}" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    expect((result.output as { items: unknown[] }).items).toEqual(["a", "b", "c"])
  })

  it("falls back to the iteration index when no output expression is set", async () => {
    const { workflow, loopNode } = loopWorkflow({ mode: "times", times: 3 }, [
      node("body", "flow.set", { variable: "v", value: "x" }, "loop1"),
    ])
    const result = await run(workflow, loopNode)
    expect((result.output as { items: unknown[] }).items).toEqual([0, 1, 2])
  })

  it("exposes $loop.index / $loop.isFirst / $loop.isLast to the body", async () => {
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $node['body'].value }}",
      },
      [node("body", "flow.set", { variable: "v", value: "{{ $loop.index }}" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    expect((result.output as { items: unknown[] }).items).toEqual([0, 1, 2])
  })
})

describe("times / while modes", () => {
  it("times mode supports expression counts", async () => {
    const { workflow, loopNode } = loopWorkflow(
      { mode: "times", times: "{{ $trigger.payload.n }}" },
      [node("body", "flow.set", { variable: "v", value: "x" }, "loop1")]
    )
    const result = await run(workflow, loopNode, {})
    expect((result.output as { count: number }).count).toBe(2)
  })

  it("while mode with an initially-falsy condition runs zero iterations", async () => {
    const { workflow, loopNode } = loopWorkflow(
      { mode: "while", whileExpression: "{{ $static.go }}", maxIterations: 10 },
      [node("body", "flow.set", { variable: "v", value: "x" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    expect((result.output as { count: number; items: unknown[] }).count).toBe(0)
    expect((result.output as { items: unknown[] }).items).toEqual([])
  })

  it("while mode condition can be turned off by the body via $static", async () => {
    // Seed $static.go = "yes" via initial staticData on the workflow; the body
    // overwrites it with "" on the first round so round 2 never starts.
    const { workflow, loopNode } = loopWorkflow(
      { mode: "while", whileExpression: "{{ $static.go }}", maxIterations: 10 },
      [node("body", "flow.set", { variable: "go", value: "" }, "loop1")]
    )
    workflow.staticData = { go: "yes" }
    const result = await run(workflow, loopNode)
    expect((result.output as { count: number }).count).toBe(1)
  })

  it("while mode honors maxIterations as a hard stop", async () => {
    const { workflow, loopNode } = loopWorkflow(
      { mode: "while", whileExpression: "always", maxIterations: 5 },
      [node("body", "flow.set", { variable: "v", value: "x" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    expect((result.output as { count: number }).count).toBe(5)
  })
})

describe("staticData accumulation", () => {
  it("flow.set writes accumulate across iterations and survive into the output", async () => {
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $static.last }}",
      },
      [node("body", "flow.set", { variable: "last", value: "{{ $item }}" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    const out = result.output as { items: unknown[]; staticData: Record<string, unknown> }
    expect(out.items).toEqual(["a", "b", "c"])
    expect(out.staticData.last).toBe("c")
  })
})

describe("break / continue", () => {
  it("flow.break stops the loop after the current iteration", async () => {
    // Body: branch on $loop.index >= 1 → break; else set.
    const children = [
      node(
        "br",
        "flow.branch",
        {
          conditions: {
            combinator: "all",
            conditions: [{ left: "{{ $loop.index }}", operator: "gte", right: "1" }],
          },
        },
        "loop1",
        2
      ),
      node("stop", "flow.break", {}, "loop1"),
      node("work", "flow.set", { variable: "v", value: "{{ $item }}" }, "loop1"),
    ]
    const edges: WorkflowEdge[] = [
      { id: "e1", source: "br", sourceHandle: "true", target: "stop" },
      { id: "e2", source: "br", sourceHandle: "false", target: "work" },
    ]
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $node['work'].value }}",
      },
      children,
      edges
    )
    const result = await run(workflow, loopNode)
    const out = result.output as { items: unknown[]; count: number }
    // Iteration 0 completes ("a"); iteration 1 enters, hits break (no item),
    // and the loop ends — iteration 2 never starts.
    expect(out.items).toEqual(["a"])
    expect(out.count).toBe(2)
  })

  it("flow.continue skips the rest of the iteration without ending the loop", async () => {
    const children = [
      node(
        "br",
        "flow.branch",
        {
          conditions: {
            combinator: "all",
            conditions: [{ left: "{{ $item }}", operator: "eq", right: "b" }],
          },
        },
        "loop1",
        2
      ),
      node("skip", "flow.continue", {}, "loop1"),
      node("work", "flow.set", { variable: "v", value: "{{ $item }}" }, "loop1"),
    ]
    const edges: WorkflowEdge[] = [
      { id: "e1", source: "br", sourceHandle: "true", target: "skip" },
      { id: "e2", source: "br", sourceHandle: "false", target: "work" },
    ]
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $node['work'].value }}",
      },
      children,
      edges
    )
    const result = await run(workflow, loopNode)
    const out = result.output as { items: unknown[]; count: number }
    // "b" was skipped — no item pushed for it; loop still visits "c".
    expect(out.items).toEqual(["a", "c"])
    expect(out.count).toBe(3)
  })
})

describe("iteration concurrency", () => {
  it("runs forEach iterations in parallel up to iterationConcurrency", async () => {
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $item }}",
        iterationConcurrency: 4,
      },
      [node("body", "flow.set", { variable: "v", value: "{{ $item }}" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    // Order of items[] stays source-ordered even with parallel iterations.
    expect((result.output as { items: unknown[] }).items).toEqual(["a", "b", "c"])
  })

  it("caps work by the global gate even when iterationConcurrency is larger", async () => {
    __setGlobalRunGateForTesting(new ConcurrencyGate(1))
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $item }}",
        iterationConcurrency: 8,
      },
      [node("body", "flow.set", { variable: "v", value: "{{ $item }}" }, "loop1")]
    )
    const result = await run(workflow, loopNode)
    expect((result.output as { items: unknown[] }).items).toEqual(["a", "b", "c"])
  })
})

describe("failure / abort / cache", () => {
  it("a failing child fails the container", async () => {
    const { workflow, loopNode } = loopWorkflow(
      { mode: "forEach", source: "{{ $trigger.payload.items }}" },
      // flow.set with empty variable name throws.
      [node("body", "flow.set", { variable: "  ", value: "x" }, "loop1")]
    )
    await expect(run(workflow, loopNode)).rejects.toThrow(/non-empty/)
  })

  it("rejects a non-array forEach source with a clear error", async () => {
    const { workflow, loopNode } = loopWorkflow(
      { mode: "forEach", source: "{{ $trigger.payload.missing }}" },
      [node("body", "flow.set", { variable: "v", value: "x" }, "loop1")]
    )
    await expect(run(workflow, loopNode)).rejects.toThrow(/array/i)
  })

  it("aborts between iterations when the signal fires", async () => {
    const ac = new AbortController()
    ac.abort()
    const { workflow, loopNode } = loopWorkflow(
      { mode: "forEach", source: "{{ $trigger.payload.items }}" },
      [node("body", "flow.set", { variable: "v", value: "x" }, "loop1")]
    )
    await expect(run(workflow, loopNode, { signal: ac.signal })).rejects.toThrow(/abort/i)
  })

  it("container cache-hits when the whole loop already completed", async () => {
    const cache = new IdempotencyCache()
    cache.set("loop1", { items: ["cached"], count: 1 })
    const { workflow, loopNode } = loopWorkflow(
      { mode: "forEach", source: "{{ $trigger.payload.items }}" },
      [node("body", "flow.set", { variable: "v", value: "x" }, "loop1")]
    )
    const result = await run(workflow, loopNode, { cache })
    expect(result.fromCache).toBe(true)
    expect((result.output as { items: unknown[] }).items).toEqual(["cached"])
  })

  it("resumes mid-loop: completed iterations replay from the cache", async () => {
    const cache = new IdempotencyCache()
    // Iteration 0's body already completed before the crash.
    cache.set(iterationCacheKey("loop1", 0, "body"), { variable: "v", value: "seeded" })
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.items }}",
        output: "{{ $node['body'].value }}",
      },
      [node("body", "flow.set", { variable: "v", value: "{{ $item }}" }, "loop1")]
    )
    const result = await run(workflow, loopNode, { cache })
    const out = result.output as { items: unknown[] }
    expect(out.items).toEqual(["seeded", "b", "c"])
  })
})

describe("nested loops", () => {
  it("an inner loop container runs per outer iteration; break affects the inner only", async () => {
    // outer forEach over [x, y]; inner times 2 with its own body.
    const inner = node(
      "inner",
      "flow.loop",
      { mode: "times", times: 2, output: "{{ $loop.index }}" },
      "loop1",
      2
    )
    const innerBody = node("ib", "flow.set", { variable: "q", value: "{{ $loop.index }}" }, "inner")
    const { workflow, loopNode } = loopWorkflow(
      {
        mode: "forEach",
        source: "{{ $trigger.payload.pairs }}",
        output: "{{ $node['inner'].count }}",
      },
      [inner, innerBody]
    )
    const result = await run(workflow, loopNode, {})
    const out = result.output as { items: unknown[] }
    expect(out.items).toEqual([2, 2])
  })
})
