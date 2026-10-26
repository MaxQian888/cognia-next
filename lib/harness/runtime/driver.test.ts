import type { Character } from "@cognia/agent-config-types"
import type {
  HarnessEvolutionRun,
  HarnessEvolutionStep,
  HarnessExecutionEvidence,
} from "@/types/harness/evolution"
import type { HarnessExperience } from "@/types/harness/experience"
import type { HarnessComponentsV1, HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { isTerminalRunStatus } from "../machine"
import { planRun } from "../recursion"
import { buildHarnessSnapshot } from "../snapshot"
import {
  makeComponents,
  makeEvidence,
  makeExperience,
  makeRun,
  makeRunConfig,
  makeSkill,
  makeTask,
} from "../test-fixtures"
import type { UsageRowLike } from "../ledger"
import {
  HarnessRunCancelledError,
  approveHarnessRunWith,
  driveHarnessRun,
  outcomeLine,
  planWaves,
  type HarnessDriverDeps,
} from "./driver"
import type { EditorSessionInput } from "./editor-runner"
import type { ProbeInput } from "./probe-runner"

const FIX = "CSV files may use ; separators."
const HEADER = "Check the CSV header first."
const agent: Character = {
  id: "agent-1",
  name: "Analyst",
  avatarColor: "x",
  systemPrompt: makeComponents().systemPrompt,
  createdAt: 1,
  updatedAt: 1,
}

interface Behaviour {
  /** Editor answer per role: change memory, keep, or throw. */
  editor(input: EditorSessionInput): "fix" | "keep" | "throw"
  /** Rollout outcome for a harness. */
  rollout(
    components: HarnessComponentsV1,
    input: ProbeInput
  ): Partial<HarnessExecutionEvidence> | "throw"
  rolloutCost: number
  editorCost: number
}

const defaultBehaviour: Behaviour = {
  editor: (input) => (input.role === "DOM" ? "keep" : "fix"),
  rollout: (components) =>
    components.memory.includes(FIX)
      ? {}
      : {
          delivered: false,
          deliverables: [],
          validation: [{ check: "deliverable report.md", passed: false, status: "failed" }],
        },
  rolloutCost: 0.01,
  editorCost: 0.02,
}

interface World {
  runs: Map<string, HarnessEvolutionRun>
  steps: Map<string, HarnessEvolutionStep>
  snapshots: Map<string, HarnessSnapshotV1>
  experiences: Map<string, HarnessExperience>
  usage: UsageRowLike[]
  calls: { probe: string[]; editor: string[]; judge: number; reflect: number; adopt: string[] }
  notified: string[]
  behaviour: Behaviour
  captureHash?: string
  clock: number
  ids: number
}

async function makeWorld(
  over: { run?: Partial<HarnessEvolutionRun>; behaviour?: Partial<Behaviour> } = {}
) {
  const base = await buildHarnessSnapshot({
    id: "snap-base",
    characterId: "agent-1",
    characterName: "Analyst",
    scope: "task",
    components: makeComponents(),
    execution: {},
    runtimeFingerprint: "hrf1-a",
    origin: { kind: "captured" },
    createdAt: 1,
  })
  const w: World = {
    runs: new Map(),
    steps: new Map(),
    snapshots: new Map([[base.id, base]]),
    experiences: new Map(),
    usage: [],
    calls: { probe: [], editor: [], judge: 0, reflect: 0, adopt: [] },
    notified: [],
    behaviour: { ...defaultBehaviour, ...over.behaviour },
    clock: 1_000,
    ids: 0,
  }
  const run = makeRun({
    baseSnapshotId: base.id,
    finalLabels: ["agg1"],
    task: makeTask(),
    ...over.run,
  })
  w.runs.set(run.id, run)
  return { w, base, run }
}

function book(w: World, runId: string, op: string, cost: number) {
  w.usage.push({
    messageId: `harness-evolution:harness:${runId}:${op}`,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: cost,
  })
}

function deps(w: World, over: Partial<HarnessDriverDeps> = {}): HarnessDriverDeps {
  return {
    ownerId: "owner-a",
    now: () => w.clock++,
    newId: () => `id-${++w.ids}`,
    leaseRenewMs: 60_000,
    store: {
      getRun: async (id) => w.runs.get(id),
      saveRun: async (next, expected) => {
        const current = w.runs.get(next.id)
        if (!current || current.version !== expected) throw new Error("conflict")
        if (next.version <= current.version) throw new Error("version must rise")
        w.runs.set(next.id, next)
        return next
      },
      claimLease: async (runId, ownerId, ttl, now) => {
        const run = w.runs.get(runId)
        if (!run || isTerminalRunStatus(run.status)) return null
        if (run.owner && run.owner.ownerId !== ownerId && run.owner.leaseExpiresAt > now)
          return null
        const next = {
          ...run,
          owner: { ownerId, leaseExpiresAt: now + ttl },
          version: run.version + 1,
        }
        w.runs.set(runId, next)
        return next
      },
      listSteps: async (runId) => [...w.steps.values()].filter((s) => s.runId === runId),
      putStep: async (step) => void w.steps.set(step.id, step),
      getSnapshot: async (id) => w.snapshots.get(id),
      putSnapshot: async (s) => void w.snapshots.set(s.id, s),
      listRolloutsByCacheKey: async (key) =>
        [...w.steps.values()].filter((s) => s.cacheKey === key),
      listExperiences: async (o) =>
        [...w.experiences.values()].filter(
          (e) =>
            (!o.characterId || e.characterId === o.characterId) &&
            (!o.domain || e.domain === o.domain) &&
            (o.includeDisabled || !e.disabled)
        ),
      getExperience: async (id) => w.experiences.get(id),
      putExperience: async (e) => void w.experiences.set(e.id, e),
      updateExperience: async (id, patch) => {
        const e = w.experiences.get(id)
        if (!e) return undefined
        const next = patch(e)
        w.experiences.set(id, next)
        return next
      },
      deleteExperience: async (id) => void w.experiences.delete(id),
      prune: async () => undefined,
    },
    runners: {
      discoverSurface: async () => ({ pluginToolDenials: [], allowedMcpServerNames: [] }),
      probe: async (input) => {
        w.calls.probe.push(`${input.label}#${input.attempt}`)
        book(w, input.run.id, `${input.label}:${input.attempt}`, w.behaviour.rolloutCost)
        const outcome = w.behaviour.rollout(input.snapshot.components, input)
        if (outcome === "throw") throw new Error("workspace could not be prepared")
        return {
          evidence: makeEvidence({ snapshotId: input.snapshot.id, ...outcome }),
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            costUsd: w.behaviour.rolloutCost,
            costUnknown: false,
          },
        }
      },
      editor: async (input) => {
        w.calls.editor.push(`${input.label}#${input.attempt}`)
        book(w, input.run.id, `${input.label}:${input.attempt}:1`, w.behaviour.editorCost)
        const answer = w.behaviour.editor(input)
        if (answer === "throw") throw new Error("provider 500")
        // A composer adds a line of its own, so its harness differs from the proposals'.
        const add = (input.role === "COMPOSE" ? [FIX, HEADER] : [FIX]).filter(
          (line) => !input.current.memory.includes(line)
        )
        const components =
          answer === "fix" && add.length
            ? { ...input.current, memory: [input.current.memory, ...add].join("\n") }
            : input.current
        return {
          outcome: components === input.current ? "kept" : "changed",
          components,
          notes: `${input.role} notes`,
          attempts: 1,
          errors: [],
          channel: "structured",
          usage: { inputTokens: 100, outputTokens: 10, costUnknown: false },
          modelCalls: 1,
        }
      },
      judge: (ctx) => async () => {
        w.calls.judge += 1
        book(w, ctx.run.id, `select:${ctx.attempt}:${w.calls.judge}`, 0.001)
        return null
      },
      reflect: async (ctx) => {
        w.calls.reflect += 1
        book(w, ctx.run.id, `reflect:${ctx.attempt}:1`, 0.001)
        return {
          parsed: {
            edits: [
              {
                component: "memory.md",
                candidates: ctx.labels.filter((l) => l !== "dom1"),
                change: "note on ; separators",
                observed: "the rollouts with the note delivered report.md",
                verdict: "helped",
              },
            ],
            retrieved: ctx.reflection.retrieved.map((e) => ({
              id: e.id,
              verdict: "helped" as const,
            })),
            experience: {
              cue: "CSV inputs with semicolon separators",
              lesson: "memory.md: say CSV files may use ; separators",
              evidence: "base1 failed, agg1 delivered",
              confidence: "medium",
              appliesWhen: ["csv input"],
              notWhen: [],
              tags: ["csv"],
            },
          },
          usage: { inputTokens: 1, outputTokens: 1, costUnknown: false },
          model: "claude-x",
        }
      },
      adopt: async (input) => {
        w.calls.adopt.push(`${input.chosen.id}:${input.approvedBy}`)
        return { scope: input.run.config.scope, approvedBy: input.approvedBy, adoptedAt: w.clock }
      },
    },
    capture: async () => {
      const base = w.snapshots.get("snap-base") as HarnessSnapshotV1
      return {
        snapshot: w.captureHash ? { ...base, contentHash: w.captureHash } : base,
        character: agent,
        skills: [],
        carriedSkillIds: ["builtin-x"],
        enabledMcpServerIds: [],
        reused: true,
      }
    },
    listUsage: async () => w.usage,
    experienceCap: async () => 200,
    notifyAwaitingApproval: async (run) => void w.notified.push(run.id),
    ...over,
  }
}

const stepOf = (w: World, label: string) => w.steps.get(`run-1:${label}`)

describe("planWaves", () => {
  it("runs independent steps of one kind together and keeps dependencies apart", () => {
    const labels = planWaves(planRun("parallel", 2)).map((wave) => wave.map((s) => s.label))
    expect(labels).toEqual([
      ["base1", "base2"],
      ["inv1", "dom1", "inv2", "dom2"],
      ["roll:inv1", "roll:dom1", "roll:inv2", "roll:dom2"],
      ["agg1", "agg2"],
      ["roll:agg1", "roll:agg2"],
      ["select"],
      ["reflect"],
    ])
    const seq = planWaves(planRun("sequential", 2)).map((wave) => wave.map((s) => s.label))
    expect(seq).toEqual([
      ["base1", "base2"],
      ["inv1", "dom1"],
      ["roll:inv1", "roll:dom1"],
      ["c1"],
      ["roll:c1"],
      ["inv2", "dom2"],
      ["roll:inv2", "roll:dom2"],
      ["c2"],
      ["roll:c2"],
      ["select"],
      ["reflect"],
    ])
  })

  it("summarises a rollout in one line", () => {
    expect(outcomeLine(makeEvidence())).toBe(
      "delivered, 1/1 checks passed, 0 tool failures, 3 steps, $0.010"
    )
    expect(
      outcomeLine(
        makeEvidence({ error: "boom", metrics: { ...makeEvidence().metrics, costUsd: undefined } })
      )
    ).toMatch(/^failed \(boom\)/)
  })
})

describe("driveHarnessRun", () => {
  it("does not reuse a rollout of a harness whose library skills drifted", async () => {
    const { w } = await makeWorld()
    // The base carries a library skill the capture no longer finds as it was.
    const drifted = await buildHarnessSnapshot({
      id: "snap-base",
      characterId: "agent-1",
      characterName: "Analyst",
      scope: "task",
      components: makeComponents({
        skills: [makeSkill({ sourceSkillId: "lib-1", sourceHash: "stale" })],
      }),
      execution: {},
      runtimeFingerprint: "hrf1-a",
      origin: { kind: "captured" },
      createdAt: 1,
    })
    w.snapshots.set(drifted.id, drifted)
    await driveHarnessRun("run-1", deps(w))
    expect(stepOf(w, "dom1")?.keptBase).toBe(true)
    expect(stepOf(w, "roll:dom1")?.cacheHitOf).toBeUndefined()
    expect(w.calls.probe).toContain("roll:dom1#1")
  })

  it("probes, composes, selects on evidence, reflects and waits for approval", async () => {
    const { w } = await makeWorld()
    const d = deps(w)
    const run = await driveHarnessRun("run-1", d)
    expect(run?.status).toBe("awaiting_approval")
    expect(run?.owner).toBeUndefined()
    expect(w.notified).toEqual(["run-1"])
    // R = 4k rollouts and P = 3k editor sessions, k = 1.
    const steps = [...w.steps.values()]
    expect(steps.filter((s) => s.kind === "rollout")).toHaveLength(4)
    expect(steps.filter((s) => s.kind === "propose" || s.kind === "compose")).toHaveLength(3)
    // dom1 kept the base, so its rollout is the base rollout, reused.
    expect(stepOf(w, "dom1")?.keptBase).toBe(true)
    expect(stepOf(w, "roll:dom1")?.cacheHitOf).toBe("run-1:base1")
    expect(w.calls.probe).toEqual(["base1#1", "roll:inv1#1", "roll:agg1#1"])
    expect(run?.decision).toMatchObject({
      outcome: "adopt",
      chosenLabel: "agg1",
      risk: "low",
      requiresApproval: true,
    })
    expect(stepOf(w, "select")?.selection).toMatchObject({
      method: "deterministic",
      dominant: ["agg1"],
    })
    expect(w.calls.judge).toBe(0)
    // The ledger is folded from the usage rows.
    expect(run?.ledger.rollouts).toBe(3)
    expect(run?.ledger.costUsd).toBeCloseTo(3 * 0.01 + 3 * 0.02 + 0.001)
    expect(run?.ledger.modelCalls).toBe(4)
    // The lesson is stored, proposed until the harness is adopted.
    expect(run?.experienceIds).toHaveLength(1)
    const lesson = w.experiences.get(run?.experienceIds[0] as string)
    expect(lesson).toMatchObject({ validationStatus: "proposed", domain: "office/reports" })
    expect(stepOf(w, "reflect")?.reflection?.experienceId).toBe(lesson?.id)

    const approved = await approveHarnessRunWith("run-1", d)
    expect(approved?.status).toBe("completed")
    expect(approved?.adoption?.approvedBy).toBe("person")
    expect(w.calls.adopt).toEqual([`${run?.decision?.chosenSnapshotId}:person`])
    expect(w.experiences.get(lesson?.id as string)?.validationStatus).toBe("verified")
    // Not twice.
    expect(await approveHarnessRunWith("run-1", d)).toBeNull()
  })

  it("adopts a low-risk task improvement by itself when allowed", async () => {
    const { w } = await makeWorld({ run: { config: makeRunConfig({ autoAdoptLowRisk: true }) } })
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("completed")
    expect(run?.adoption?.approvedBy).toBe("auto-low-risk")
    expect(w.notified).toEqual([])
  })

  it("keeps the base when no editor changed anything, without a reflection", async () => {
    const { w } = await makeWorld({ behaviour: { editor: () => "keep" } })
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("completed")
    expect(run?.decision).toMatchObject({ outcome: "keep-base" })
    expect(stepOf(w, "select")?.selection?.unchanged).toEqual(["agg1"])
    expect(stepOf(w, "reflect")?.status).toBe("skipped")
    expect(w.calls.reflect).toBe(0)
    // Every candidate rollout was the base rollout again.
    expect(w.calls.probe).toEqual(["base1#1"])
  })

  it("stops at the budget and keeps the base", async () => {
    const { w } = await makeWorld({
      run: { config: makeRunConfig({ budget: { ...makeRunConfig().budget, maxCostUsd: 0.05 } }) },
      behaviour: { rolloutCost: 0.06 },
    })
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("budget_exceeded")
    expect(run?.decision).toMatchObject({ outcome: "keep-base" })
    expect(run?.error).toMatch(/maxCostUsd/)
    expect(w.calls.editor).toEqual([])
  })

  it("stops a converged sequential run early and selects among the finished rounds", async () => {
    const { w } = await makeWorld({
      run: { config: makeRunConfig({ mode: "sequential", k: 2 }), finalLabels: ["c1", "c2"] },
      behaviour: { editor: () => "keep" },
    })
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("completed")
    expect(run?.stopReason).toMatch(/converged/)
    expect(run?.finalLabels).toEqual(["c1"])
    expect(stepOf(w, "inv2")?.status).toBe("skipped")
    expect(stepOf(w, "roll:c2")?.status).toBe("skipped")
    expect(w.calls.editor).toEqual(["inv1#1", "dom1#1", "c1#1"])
  })

  it("feeds a sequential round the history of the rounds before it", async () => {
    const seen: EditorSessionInput[] = []
    const { w } = await makeWorld({
      run: { config: makeRunConfig({ mode: "sequential", k: 2 }), finalLabels: ["c1", "c2"] },
      behaviour: {
        editor: (input) => {
          seen.push(input)
          return input.round === 1 && input.role === "INV"
            ? "fix"
            : input.role === "COMPOSE"
              ? "fix"
              : "keep"
        },
      },
    })
    const run = await driveHarnessRun("run-1", deps(w))
    const inv2 = seen.find((s) => s.label === "inv2") as EditorSessionInput
    expect(Object.keys(inv2.context)).toEqual(
      expect.arrayContaining(["decisions/inv1.md", "decisions/c1.md", "rollouts/roll:c1.md"])
    )
    expect(inv2.current.memory).toContain(FIX)
    const c1 = seen.find((s) => s.label === "c1") as EditorSessionInput
    expect(Object.keys(c1.context)).toEqual(
      expect.arrayContaining(["pool/inv1/harness.diff", "pool/dom1/rollout.md"])
    )
    expect(run?.decision?.outcome).toBe("adopt")
  })

  it("re-runs a rollout that did not get a fair attempt, and fails the run when it never does", async () => {
    let first = true
    const flaky = await makeWorld({
      behaviour: {
        rollout: (components, input) => {
          if (input.label === "base1" && first) {
            first = false
            return { error: "Request timed out after 600s" }
          }
          return defaultBehaviour.rollout(components, input)
        },
      },
    })
    const run = await driveHarnessRun("run-1", deps(flaky.w))
    expect(flaky.w.calls.probe.slice(0, 2)).toEqual(["base1#1", "base1#2"])
    expect(stepOf(flaky.w, "base1")?.attempts).toBe(2)
    expect(run?.status).toBe("awaiting_approval")

    const down = await makeWorld({ behaviour: { rollout: () => ({ error: "429 rate limit" }) } })
    const failed = await driveHarnessRun("run-1", deps(down.w))
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toMatch(/base1: The rollout did not get a fair attempt/)
    expect(down.w.calls.probe).toEqual(["base1#1", "base1#2"])
  })

  it("does not retry an error a second attempt cannot fix", async () => {
    const { w } = await makeWorld()
    const d = deps(w)
    d.runners.probe = async () => {
      w.calls.probe.push("x")
      const error = new Error("data.csv changed")
      error.name = "InputFileChangedError"
      throw error
    }
    const run = await driveHarnessRun("run-1", d)
    expect(run?.status).toBe("failed")
    expect(w.calls.probe).toEqual(["x"])
  })

  it("resumes where a dead driver stopped, re-running only the unfinished step", async () => {
    const { w } = await makeWorld({
      run: { status: "proposing", owner: { ownerId: "dead", leaseExpiresAt: 0 }, startedAt: 1 },
    })
    w.steps.set("run-1:base1", {
      id: "run-1:base1",
      runId: "run-1",
      label: "base1",
      kind: "rollout",
      status: "succeeded",
      snapshotId: "snap-base",
      evidence: makeEvidence({
        delivered: false,
        deliverables: [],
        validation: [{ check: "x", passed: false, status: "failed" }],
      }),
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      updatedAt: 1,
    })
    w.steps.set("run-1:inv1", {
      id: "run-1:inv1",
      runId: "run-1",
      label: "inv1",
      kind: "propose",
      dim: "INV",
      status: "running",
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      updatedAt: 1,
    })
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("awaiting_approval")
    expect(w.calls.probe).not.toContain("base1#1")
    expect(w.calls.editor).toContain("inv1#2")
    expect(stepOf(w, "inv1")?.attempts).toBe(2)
  })

  it("leaves a run another driver holds alone", async () => {
    const { w } = await makeWorld({
      run: { status: "probing", owner: { ownerId: "other", leaseExpiresAt: 10 ** 12 } },
    })
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("probing")
    expect(w.calls.probe).toEqual([])
  })

  it("cancels on request, marking the step in flight interrupted", async () => {
    const { w } = await makeWorld()
    const controller = new AbortController()
    const d = deps(w)
    d.runners.probe = async (input) => {
      controller.abort(new HarnessRunCancelledError())
      input.signal.throwIfAborted()
      throw new Error("unreachable")
    }
    const run = await driveHarnessRun("run-1", d, { signal: controller.signal })
    expect(run?.status).toBe("cancelled")
    expect(stepOf(w, "base1")?.status).toBe("interrupted")
  })

  it("stops without writing when the run was finished elsewhere", async () => {
    const { w } = await makeWorld()
    const d = deps(w)
    d.runners.probe = async () => {
      const current = w.runs.get("run-1") as HarnessEvolutionRun
      w.runs.set("run-1", { ...current, status: "cancelled", version: current.version + 1 })
      return {
        evidence: makeEvidence(),
        usage: { inputTokens: 0, outputTokens: 0, costUnknown: false },
      }
    }
    const run = await driveHarnessRun("run-1", d)
    expect(w.runs.get("run-1")?.status).toBe("cancelled")
    expect(run?.status).not.toBe("failed")
  })

  it("fails a run whose agent changed since it started", async () => {
    const { w } = await makeWorld()
    w.captureHash = "something-else"
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("failed")
    expect(run?.error).toMatch(/changed since this run started/)
    expect(w.calls.probe).toEqual([])
  })

  it("hands editors the library's lessons, counts the use and records the verdict", async () => {
    const { w } = await makeWorld()
    w.experiences.set("exp-1", makeExperience({ runtimeFingerprint: "hrf1-a" }))
    const seen: EditorSessionInput[] = []
    const d = deps(w)
    const editor = d.runners.editor
    d.runners.editor = async (input) => {
      seen.push(input)
      return editor(input)
    }
    const run = await driveHarnessRun("run-1", d)
    expect(run?.retrievedExperienceIds).toEqual(["exp-1"])
    expect(Object.keys(seen[0].context)).toContain("library/exp-1.md")
    const exp = w.experiences.get("exp-1") as HarnessExperience
    expect(exp.retrievedCount).toBe(1)
    expect(exp.helpedCount).toBe(1)
    expect(exp.validationStatus).toBe("verified")
  })

  it("merges a repeated lesson instead of adding it twice", async () => {
    const { w } = await makeWorld({ run: { config: makeRunConfig({ useExperiences: false }) } })
    w.experiences.set(
      "exp-old",
      makeExperience({
        id: "exp-old",
        problemPattern: "CSV inputs with semicolon separators",
        lesson: "memory.md: say CSV files may use ; separators",
      })
    )
    const run = await driveHarnessRun("run-1", deps(w))
    expect(run?.experienceIds).toEqual(["exp-old"])
    expect(stepOf(w, "reflect")?.reflection?.mergedInto).toBe("exp-old")
    expect(w.experiences.get("exp-old")?.supportRunIds).toContain("run-1")
  })

  it("goes on without a lesson when the reflection fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const { w } = await makeWorld()
    const d = deps(w)
    d.runners.reflect = async () => {
      throw new Error("reflector down")
    }
    const run = await driveHarnessRun("run-1", d)
    expect(run?.status).toBe("awaiting_approval")
    expect(stepOf(w, "reflect")?.status).toBe("failed")
    expect(run?.experienceIds).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
