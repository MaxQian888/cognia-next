/**
 * @jest-environment jsdom
 *
 * flow.branch / flow.switch typeVersion 2 — structured-condition executors.
 * Co-located with built-ins.ts; split from built-ins.test.ts to keep the
 * (already heavy) v1 suite size in check.
 */
import "fake-indexeddb/auto"
// Importing built-ins triggers their side-effecting registrations.
import "."
import { getExecutor } from "../registry"
import type {
  StepExecutionContext,
  StepExecutionResult,
  TriggerEvent,
  WorkflowNodeKind,
} from "@/types/workflow/visual"

const trigger: TriggerEvent = {
  workflowId: "wf",
  kind: "trigger.manual",
  payload: {},
  originAt: 1_700_000_000,
}

function makeCtx<T extends Record<string, unknown>>(
  kind: WorkflowNodeKind,
  params: T
): StepExecutionContext<T> {
  return {
    runId: "run_test",
    workflowId: "wf",
    stepId: "n_test",
    params,
    upstream: {},
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  } as StepExecutionContext<T>
}

async function execV2(
  kind: WorkflowNodeKind,
  params: Record<string, unknown>
): Promise<StepExecutionResult> {
  const reg = getExecutor(kind, 2)
  if (!reg) throw new Error(`No v2 executor for ${kind}`)
  return reg.execute(makeCtx(kind, params))
}

describe("flow.branch v2", () => {
  it("routes to the true handle when the group passes", async () => {
    const r = await execV2("flow.branch", {
      conditions: {
        combinator: "all",
        conditions: [{ left: "ok", operator: "eq", right: "OK" }],
      },
    })
    expect(r.decision).toBe("true")
    expect(r.output).toMatchObject({ decision: "true" })
  })

  it("routes to the false handle when the group fails", async () => {
    const r = await execV2("flow.branch", {
      conditions: {
        combinator: "all",
        conditions: [{ left: 1, operator: "gt", right: 2 }],
      },
    })
    expect(r.decision).toBe("false")
  })

  it("combines with any", async () => {
    const r = await execV2("flow.branch", {
      conditions: {
        combinator: "any",
        conditions: [
          { left: 1, operator: "gt", right: 2 },
          { left: "x", operator: "isNotEmpty" },
        ],
      },
    })
    expect(r.decision).toBe("true")
  })

  it("missing or empty conditions route to false (no condition set means no)", async () => {
    const none = await execV2("flow.branch", {})
    expect(none.decision).toBe("false")
    const empty = await execV2("flow.branch", {
      conditions: { combinator: "all", conditions: [] },
    })
    expect(empty.decision).toBe("false")
  })
})

describe("flow.switch v2", () => {
  const cases = [
    {
      id: "c_low",
      label: "Low",
      when: { combinator: "all", conditions: [{ left: 3, operator: "lt", right: 5 }] },
    },
    {
      id: "c_high",
      label: "High",
      when: { combinator: "all", conditions: [{ left: 3, operator: "gte", right: 5 }] },
    },
  ]

  it("routes to the first matching case id", async () => {
    const r = await execV2("flow.switch", { cases })
    expect(r.decision).toBe("c_low")
    expect(r.output).toMatchObject({ decision: "c_low", matchedLabel: "Low" })
  })

  it("first match wins when several cases pass", async () => {
    const r = await execV2("flow.switch", {
      cases: [
        {
          id: "c_a",
          label: "A",
          when: { combinator: "all", conditions: [{ left: 1, operator: "eq", right: 1 }] },
        },
        {
          id: "c_b",
          label: "B",
          when: { combinator: "all", conditions: [{ left: 1, operator: "eq", right: 1 }] },
        },
      ],
    })
    expect(r.decision).toBe("c_a")
  })

  it("falls through to default when nothing matches", async () => {
    const r = await execV2("flow.switch", {
      cases: [
        {
          id: "c_x",
          label: "X",
          when: { combinator: "all", conditions: [{ left: 1, operator: "eq", right: 2 }] },
        },
      ],
    })
    expect(r.decision).toBe("default")
    expect(r.output).toMatchObject({ decision: "default" })
  })

  it("handles missing case ids with an index fallback", async () => {
    const r = await execV2("flow.switch", {
      cases: [
        {
          label: "anon",
          when: { combinator: "all", conditions: [{ left: 1, operator: "eq", right: 1 }] },
        },
      ],
    })
    expect(r.decision).toBe("case-0")
  })

  it("empty cases route to default", async () => {
    const r = await execV2("flow.switch", { cases: [] })
    expect(r.decision).toBe("default")
  })
})
