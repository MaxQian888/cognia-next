import type { HarnessEvolutionRun, HarnessRunStatus } from "@/types/harness/evolution"
import { HARNESS_RUN_STATUSES } from "@/types/harness/evolution"
import { emptyLedger } from "./budget"
import {
  HarnessRunTransitionError,
  allowedTransitions,
  canTransition,
  isActiveRunStatus,
  isOrphaned,
  isTerminalRunStatus,
  runDedupeKey,
  transitionRun,
} from "./machine"
import { makeTask } from "./test-fixtures"

function run(
  status: HarnessRunStatus,
  overrides: Partial<HarnessEvolutionRun> = {}
): HarnessEvolutionRun {
  return {
    id: "run-1",
    characterId: "agent-1",
    characterName: "Analyst",
    trigger: "manual",
    task: makeTask(),
    config: {
      mode: "parallel",
      k: 1,
      scope: "session",
      editable: ["systemPrompt", "memory"],
      models: {},
      budget: {
        maxIterations: 1,
        maxCandidates: 2,
        maxParallelRuns: 1,
        maxModelCalls: 10,
        maxTokens: 100_000,
        maxCostUsd: 1,
        maxWallTimeMs: 600_000,
        maxTurnsPerRollout: 10,
      },
      autoAdoptLowRisk: false,
      useExperiences: true,
      editorChannel: "auto",
      probe: { allowedMcpServerIds: [], networkOff: true },
      seed: 7,
    },
    status,
    round: 0,
    finalLabels: [],
    experienceIds: [],
    ledger: emptyLedger(),
    dedupeKey: "k",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("run statuses", () => {
  it("classifies every status as exactly one of terminal, active or resting", () => {
    for (const status of HARNESS_RUN_STATUSES) {
      expect(isTerminalRunStatus(status) && isActiveRunStatus(status)).toBe(false)
    }
    expect(isTerminalRunStatus("completed")).toBe(true)
    expect(isActiveRunStatus("probing")).toBe(true)
    expect(isActiveRunStatus("awaiting_approval")).toBe(false)
    expect(isTerminalRunStatus("awaiting_approval")).toBe(false)
  })

  it("walks the happy path and the sequential loop", () => {
    const path: HarnessRunStatus[] = [
      "queued",
      "snapshotting",
      "reference_running",
      "proposing",
      "probing",
      "composing",
      "probing",
      "proposing",
      "probing",
      "composing",
      "probing",
      "evaluating",
      "reflecting",
      "awaiting_approval",
      "adopting",
      "completed",
      "rolled_back",
    ]
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true)
  })

  it("reflects before approval, allows keep-base and auto-adopt shortcuts, nothing out of a terminal status", () => {
    expect(canTransition("evaluating", "reflecting")).toBe(true)
    expect(canTransition("evaluating", "adopting")).toBe(false)
    expect(canTransition("reflecting", "completed")).toBe(true)
    expect(canTransition("reflecting", "adopting")).toBe(true)
    expect(canTransition("adopting", "reflecting")).toBe(false)
    expect(canTransition("awaiting_approval", "rejected")).toBe(true)
    expect(canTransition("queued", "evaluating")).toBe(false)
    for (const status of [
      "failed",
      "cancelled",
      "budget_exceeded",
      "rejected",
      "rolled_back",
    ] as const) {
      expect(allowedTransitions(status)).toEqual([])
    }
  })

  it("lets an interrupted run resume into any work phase", () => {
    for (const to of ["probing", "composing", "reflecting", "awaiting_approval"] as const) {
      expect(canTransition("interrupted", to)).toBe(true)
    }
    expect(canTransition("interrupted", "completed")).toBe(false)
  })
})

describe("transitionRun", () => {
  it("bumps the version, stamps times and applies the patch", () => {
    const next = transitionRun(run("queued"), "snapshotting", { round: 1 }, 50)
    expect(next).toMatchObject({
      status: "snapshotting",
      version: 2,
      updatedAt: 50,
      startedAt: 50,
      round: 1,
    })
    const done = transitionRun(
      run("reflecting", { owner: { ownerId: "o", leaseExpiresAt: 99 } }),
      "completed",
      {},
      60
    )
    expect(done.endedAt).toBe(60)
    expect(done).not.toHaveProperty("owner")
  })

  it("throws a typed error on an illegal move", () => {
    expect(() => transitionRun(run("completed"), "probing", {}, 1)).toThrow(
      HarnessRunTransitionError
    )
  })
})

describe("isOrphaned", () => {
  it("is true only for an active run without a live lease", () => {
    expect(isOrphaned(run("probing"), 10)).toBe(true)
    expect(isOrphaned(run("probing", { owner: { ownerId: "o", leaseExpiresAt: 20 } }), 10)).toBe(
      false
    )
    expect(isOrphaned(run("probing", { owner: { ownerId: "o", leaseExpiresAt: 5 } }), 10)).toBe(
      true
    )
    expect(isOrphaned(run("awaiting_approval"), 10)).toBe(false)
  })
})

describe("runDedupeKey", () => {
  it("ignores budget and editable order but not the base or the task", async () => {
    const config = run("queued").config
    const a = await runDedupeKey({
      characterId: "a",
      taskInputHash: "t",
      baseContentHash: "b",
      config,
    })
    const b = await runDedupeKey({
      characterId: "a",
      taskInputHash: "t",
      baseContentHash: "b",
      config: {
        ...config,
        editable: ["memory", "systemPrompt"],
        budget: { ...config.budget, maxCostUsd: 9 },
      },
    })
    expect(a).toMatch(/^hrd1-/)
    expect(a).toBe(b)
    expect(
      await runDedupeKey({ characterId: "a", taskInputHash: "t", baseContentHash: "c", config })
    ).not.toBe(a)
    expect(
      await runDedupeKey({ characterId: "a", taskInputHash: "u", baseContentHash: "b", config })
    ).not.toBe(a)
  })
})
