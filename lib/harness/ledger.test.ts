import {
  foldRunUsage,
  ledgerFromUsage,
  parseOperationId,
  runUsageSessionId,
  type UsageRowLike,
} from "./ledger"
import type { HarnessStepKind } from "@/types/harness/evolution"

const row = (op: string, cost: number, over: Partial<UsageRowLike> = {}): UsageRowLike => ({
  messageId: `harness-evolution:harness:run-1:${op}`,
  inputTokens: 100,
  outputTokens: 10,
  costUsd: cost,
  ...over,
})

const kinds: Record<string, HarnessStepKind> = {
  base1: "rollout",
  "roll:inv1": "rollout",
  inv1: "propose",
  agg1: "compose",
  select: "select",
  reflect: "reflect",
}
const kindOf = (label: string) => kinds[label]

describe("parseOperationId", () => {
  it("peels attempt and call numbers from the right", () => {
    expect(parseOperationId("harness-evolution:harness:run-1:base1:2", "run-1")).toEqual({
      label: "base1",
      attempt: 2,
    })
    expect(parseOperationId("harness-evolution:harness:run-1:roll:inv1:1", "run-1")).toEqual({
      label: "roll:inv1",
      attempt: 1,
    })
    expect(parseOperationId("harness-evolution:harness:run-1:inv1:1:2", "run-1")).toEqual({
      label: "inv1",
      attempt: 1,
      call: 2,
    })
    expect(parseOperationId("harness-evolution:harness:run-2:base1:1", "run-1")).toBeNull()
    expect(parseOperationId("harness-evolution:harness:run-1:base1", "run-1")).toBeNull()
    expect(parseOperationId("harness-evolution:harness:run-1:7", "run-1")).toBeNull()
    expect(runUsageSessionId("r")).toBe("harness:r")
  })
})

describe("foldRunUsage / ledgerFromUsage", () => {
  const rows = [
    row("base1:1", 0.1),
    row("base1:2", 0.3),
    row("roll:inv1:1", 0.2),
    row("inv1:1:1", 0.05),
    row("inv1:1:2", 0.05),
    row("select:1:1", 0.01, { costKnown: false, costUsd: 0 }),
    row("ghost:1", 1),
    { ...row("x:1", 9), messageId: "chat:other" },
  ]

  it("sums spend by label and counts model calls only for editor and judge rows", () => {
    const folded = foldRunUsage(rows, "run-1", kindOf)
    expect(folded.total.modelCalls).toBe(3)
    expect(folded.total.costUnknown).toBe(true)
    expect(folded.total.costUsd).toBeCloseTo(1.7)
    expect(folded.byLabel.get("inv1")).toMatchObject({ costUsd: 0.1, modelCalls: 2 })
    expect(folded.byAttempt.get("base1#2")?.costUsd).toBe(0.3)
  })

  it("builds the ledger with the worst attempt per kind", () => {
    const ledger = ledgerFromUsage({
      rows,
      runId: "run-1",
      kindOf,
      finishedRollouts: 3,
      finishedSessions: 1,
      startedAt: 5,
    })
    expect(ledger).toMatchObject({
      costUnknown: true,
      modelCalls: 3,
      rollouts: 3,
      sessions: 1,
      startedAt: 5,
      inputTokens: 700,
      outputTokens: 70,
    })
    expect(ledger.maxObservedCostUsd).toEqual({ rollout: 0.3, propose: 0.1 })
    expect(
      ledgerFromUsage({ rows: [], runId: "r", kindOf, finishedRollouts: 0, finishedSessions: 0 })
    ).toEqual({
      costUsd: 0,
      costUnknown: false,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      rollouts: 0,
      sessions: 0,
      maxObservedCostUsd: {},
    })
  })
})
