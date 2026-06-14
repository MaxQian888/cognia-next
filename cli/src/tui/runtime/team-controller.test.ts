/**
 * @jest-environment node
 */
import { formatTeamDoc, teamAuto, teamList, teamRunUnavailable, teamShow } from "./team-controller"
import type { Team } from "@/lib/claude/types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { TuiAction } from "../state/types"
import type { ResolvedConfig } from "../../config/schema"
import type { AutoOrchestrationProposal } from "@/lib/ai/agent/team/auto/types"
import { AutoOrchestrationPiiError } from "@/lib/ai/agent/team/auto/auto-orchestrate"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const team = (id: string, name: string, members = 2): Team =>
  ({
    id,
    name,
    avatarColor: "#000",
    members: Array.from({ length: members }, (_, i) => ({ characterId: `c${i}` })),
    orchestration: "round-robin",
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Team

describe("teamList", () => {
  it("opens a select overlay wired to `team show`", async () => {
    const { dispatch, actions } = recorder()
    await teamList({ dispatch, ensureDb: async () => {}, list: async () => [team("t1", "Squad")] })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "team show",
        items: [{ id: "t1", label: "Squad" }],
      },
    })
  })

  it("notices when there are no teams", async () => {
    const { dispatch, actions } = recorder()
    await teamList({ dispatch, ensureDb: async () => {}, list: async () => [] })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})

describe("teamShow", () => {
  it("opens a markdown document with the team's orchestration + members", async () => {
    const { dispatch, actions } = recorder()
    await teamShow("t1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => team("t1", "Squad", 3),
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown" },
    })
    const body = (actions[0] as { overlay: { body: string } }).overlay.body
    expect(body).toContain("Squad")
    expect(body).toContain("round-robin")
    expect(body).toContain("c0")
    expect(body).toContain("c2")
  })

  it("notices a missing team", async () => {
    const { dispatch, actions } = recorder()
    await teamShow("x", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("formatTeamDoc", () => {
  it("marks the supervisor lead and renders member overrides", () => {
    const supervised = {
      id: "t2",
      name: "Brain Trust",
      description: "deep work",
      avatarColor: "#000",
      orchestration: "supervisor",
      supervisorCharacterId: "lead1",
      members: [
        { characterId: "lead1", role: "Lead", modelOverride: "opus" },
        { characterId: "w1", role: "Worker", allowedToolsOverride: ["read", "grep"] },
      ],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Team
    const doc = formatTeamDoc(supervised)
    expect(doc).toContain("# Brain Trust")
    expect(doc).toContain("supervisor")
    expect(doc).toContain("lead `lead1`")
    expect(doc).toContain("👑")
    expect(doc).toContain("model: opus")
    expect(doc).toContain("tools: read, grep")
    expect(doc).toContain("> deep work")
    expect(doc).toContain("desktop app")
  })
})

describe("teamRunUnavailable", () => {
  it("explains that team execution is desktop-only", () => {
    const { dispatch, actions } = recorder()
    teamRunUnavailable({ dispatch })
    expect((actions[0] as { message: string }).message).toContain("desktop")
  })
})

describe("teamAuto", () => {
  const config = {} as ResolvedConfig
  const stubClient: LlmClient = { complete: async () => "{}" }
  const proposal: AutoOrchestrationProposal = {
    objective: "Audit the auth layer",
    assessment: {
      recommendedPattern: "parallel_specialists",
      confidence: 0.8,
      reason: "Independent angles.",
      factors: {
        taskComplexity: "moderate",
        specializationNeeded: true,
        contextIsolationNeeded: false,
        delegationCandidate: false,
        budgetPressure: "low",
      },
      createdAt: new Date("2026-06-14T00:00:00Z"),
    },
    roster: [
      { name: "Lead", role: "lead", description: "coordinates" },
      { name: "Security", role: "teammate", description: "reviews", specialization: "security" },
    ],
    tasks: [{ title: "Scan", description: "scan", assignedTo: 1, dependencies: [] }],
  }

  const baseDeps = (overrides = {}) => ({
    config,
    sessionId: "s1",
    ensureDb: async () => {},
    resolveSettings: () => ({}) as never,
    getSession: async () => ({}) as never,
    buildClient: () => stubClient,
    plan: async () => proposal,
    ...overrides,
  })

  it("renders the proposal as a markdown document", async () => {
    const { dispatch, actions } = recorder()
    await teamAuto("Audit the auth layer", { dispatch, ...baseDeps() })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "Auto-composed team", format: "markdown" },
    })
    const body = (actions[0] as { overlay: { body: string } }).overlay.body
    expect(body).toContain("Audit the auth layer")
    expect(body).toContain("Security")
    expect(body).toContain("Preview only")
  })

  it("notices on an empty objective without planning", async () => {
    const { dispatch, actions } = recorder()
    const plan = jest.fn()
    await teamAuto("   ", { dispatch, ...baseDeps({ plan }) })
    expect(plan).not.toHaveBeenCalled()
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("notices when no renderer LLM client can be built", async () => {
    const { dispatch, actions } = recorder()
    await teamAuto("do it", { dispatch, ...baseDeps({ buildClient: () => null }) })
    expect((actions[0] as { message: string }).message).toContain("renderer-side API key")
  })

  it("surfaces the PII refusal distinctly", async () => {
    const { dispatch, actions } = recorder()
    const plan = async () => {
      throw new AutoOrchestrationPiiError()
    }
    await teamAuto("leak me", { dispatch, ...baseDeps({ plan }) })
    expect((actions[0] as { message: string }).message).toContain("sensitive data")
  })

  it("surfaces a generic planning failure", async () => {
    const { dispatch, actions } = recorder()
    const plan = async () => {
      throw new Error("model exploded")
    }
    await teamAuto("do it", { dispatch, ...baseDeps({ plan }) })
    expect((actions[0] as { message: string }).message).toContain("model exploded")
  })
})
