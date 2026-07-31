import { orchestrateRun, parseOrchestrateArgs } from "./orchestrate-controller"
import type { OrchestrateDeps } from "./orchestrate-controller"
import type { AutoOrchestrationProposal } from "@/lib/ai/agent/team/auto/types"
import type { TeamExecutionPattern, TeamRoutingAssessment } from "@/types/agent/agent-team"
import type { TuiAction } from "../state/types"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/w" }

const assessment = (pattern: TeamExecutionPattern): TeamRoutingAssessment => ({
  recommendedPattern: pattern,
  confidence: 0.8,
  reason: "r",
  factors: {
    taskComplexity: "moderate",
    specializationNeeded: false,
    contextIsolationNeeded: false,
    delegationCandidate: false,
    budgetPressure: "low",
  },
  createdAt: new Date(0),
})

const proposalWith = (pattern: TeamExecutionPattern, kind: string): AutoOrchestrationProposal => ({
  objective: "the objective",
  assessment: assessment(pattern),
  roster: [],
  tasks: [],
  executor: { kind: kind as never, fromPattern: pattern, confidence: 0.8, reason: "because" },
})

function baseDeps(over: Partial<OrchestrateDeps> = {}): {
  deps: OrchestrateDeps
  actions: TuiAction[]
} {
  const actions: TuiAction[] = []
  const deps: OrchestrateDeps = {
    dispatch: (a) => actions.push(a),
    config,
    sessionId: "s1",
    ensureDb: async () => undefined,
    resolveSettings: () => ({}) as never,
    getSession: async () => null,
    buildClient: () => ({ complete: async () => "{}" }) as never,
    loadAliases: async () => ["fast", "balanced"],
    runPrompt: async ({ modelAlias }) => ({ completion: `out(${modelAlias})`, model: modelAlias }),
    ...over,
  }
  return { deps, actions }
}

const overlays = (actions: TuiAction[]) => actions.filter((a) => a.type === "OVERLAY_OPEN")

describe("parseOrchestrateArgs", () => {
  it("extracts --consensus / --verify and leaves the objective", () => {
    expect(parseOrchestrateArgs("build a parser --consensus")).toEqual({
      objective: "build a parser",
      signal: { consensusNeeded: true },
    })
    expect(parseOrchestrateArgs("--verify prove the lemma")).toEqual({
      objective: "prove the lemma",
      signal: { verificationNeeded: true },
    })
    expect(parseOrchestrateArgs("just do it")).toEqual({ objective: "just do it", signal: {} })
  })
})

describe("orchestrateRun", () => {
  it("shows usage when no objective is given", async () => {
    const { deps, actions } = baseDeps()
    await orchestrateRun("   ", deps)
    expect(actions.some((a) => a.type === "NOTICE")).toBe(true)
  })

  it("runs a council for a --consensus objective and shows the report", async () => {
    const { deps, actions } = baseDeps({
      plan: (async () => proposalWith("manager_worker", "council")) as never,
    })
    await orchestrateRun("decide arch --consensus", deps)
    const doc = overlays(actions).find((a) => a.overlay.kind === "document")
    expect(doc).toBeDefined()
    if (doc && doc.overlay.kind === "document") {
      expect(doc.overlay.title).toContain("Council")
      expect(doc.overlay.body).toContain("Council:")
    }
  })

  it("runs an ensemble for a --verify objective", async () => {
    const { deps, actions } = baseDeps({
      plan: (async () => proposalWith("manager_worker", "ensemble")) as never,
    })
    await orchestrateRun("verify it --verify", deps)
    const doc = overlays(actions).find(
      (a) => a.overlay.kind === "document" && a.overlay.title.includes("Ensemble")
    )
    expect(doc).toBeDefined()
  })

  it("runs a single routed prompt for a single-agent task", async () => {
    const { deps, actions } = baseDeps({
      plan: (async () => proposalWith("single_agent_recommended", "single-send")) as never,
    })
    await orchestrateRun("trivial task", deps)
    const doc = overlays(actions).find(
      (a) => a.overlay.kind === "document" && a.overlay.title.includes("Single")
    )
    expect(doc).toBeDefined()
    if (doc && doc.overlay.kind === "document") expect(doc.overlay.body).toContain("out(fast)")
  })

  it("previews (does not execute) a team-shaped executor and defers to desktop", async () => {
    let ran = false
    const { deps, actions } = baseDeps({
      plan: (async () => proposalWith("parallel_specialists", "team-flat")) as never,
      runPrompt: async () => {
        ran = true
        return { completion: "" }
      },
    })
    await orchestrateRun("big migration", deps)
    expect(ran).toBe(false)
    const doc = overlays(actions).find((a) => a.overlay.kind === "document")
    expect(doc?.overlay.kind === "document" && doc.overlay.body).toContain("desktop")
  })

  it("explains the per-kind desktop behavior for handoff executors", async () => {
    const bg = baseDeps({
      plan: (async () => proposalWith("background_handoff", "background-handoff")) as never,
    })
    await orchestrateRun("nightly cleanup", bg.deps)
    const bgDoc = overlays(bg.actions).find((a) => a.overlay.kind === "document")
    expect(bgDoc?.overlay.kind === "document" && bgDoc.overlay.body).toContain(
      "one-shot scheduler task"
    )

    const ext = baseDeps({
      plan: (async () => proposalWith("external_handoff", "external-handoff")) as never,
    })
    await orchestrateRun("delegate out", ext.deps)
    const extDoc = overlays(ext.actions).find((a) => a.overlay.kind === "document")
    expect(extDoc?.overlay.kind === "document" && extDoc.overlay.body).toContain(
      "awaiting external pickup"
    )
  })

  it("notices when no renderer-side client is available", async () => {
    const { deps, actions } = baseDeps({ buildClient: () => null })
    await orchestrateRun("do it", deps)
    expect(actions.every((a) => a.type !== "OVERLAY_OPEN")).toBe(true)
    expect(actions.some((a) => a.type === "NOTICE")).toBe(true)
  })
})
