// `/plan` command family — the surface that makes every PlanSource reachable.
//
// `@/lib/agent/plan/projections` is deliberately NOT mocked: the point of these
// tests is to prove the real `planInputFromGoal` / `planInputFromTeam` mappers
// are on a live call path, not just that a stub was invoked.

jest.mock("@/lib/agent/plan/runtime", () => ({ getPlanRuntime: jest.fn() }))
jest.mock("@/lib/agent/plan/plan-settings", () => ({ loadPlanConfigDefaults: jest.fn() }))
jest.mock("@/lib/agent/plan/planner", () => ({ decomposeIntoPlan: jest.fn() }))
jest.mock("@/lib/ai/generation/agent-role-client", () => ({
  buildAgentRoleLlmClient: jest.fn(),
}))
jest.mock("@/lib/goal/runtime", () => ({ getGoalRuntime: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: jest.fn() } }))
jest.mock("@/stores/agent/agent-team-store", () => ({ useAgentTeamStore: { getState: jest.fn() } }))
jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: jest.fn(),
  listWorkflows: jest.fn(),
  createWorkflow: jest.fn(),
}))

import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { loadPlanConfigDefaults } from "@/lib/agent/plan/plan-settings"
import { decomposeIntoPlan } from "@/lib/agent/plan/planner"
import { buildAgentRoleLlmClient } from "@/lib/ai/generation/agent-role-client"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { getSession } from "@/lib/db/sessions"
import { useSettingsStore } from "@/stores/settings"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { createWorkflow, getWorkflow, listWorkflows } from "@/lib/db/workflows"
import { soloTeamId } from "@/lib/agent/plan-mode-bridge"
import { dispatchPlanSubcommand } from "./plan"
import type { SlashContext } from "../builtin"
import type { AgentPlan, CreatePlanInput } from "@/types/agent/plan"

const getPlanRuntimeMock = getPlanRuntime as jest.Mock
const loadPlanConfigDefaultsMock = loadPlanConfigDefaults as jest.Mock
const decomposeIntoPlanMock = decomposeIntoPlan as jest.Mock
const buildAgentRoleLlmClientMock = buildAgentRoleLlmClient as jest.Mock
const getGoalRuntimeMock = getGoalRuntime as jest.Mock
const getSessionMock = getSession as jest.Mock
const settingsStateMock = useSettingsStore.getState as jest.Mock
const teamStateMock = useAgentTeamStore.getState as jest.Mock
const getWorkflowMock = getWorkflow as jest.Mock
const listWorkflowsMock = listWorkflows as jest.Mock
const createWorkflowMock = createWorkflow as jest.Mock

const createPlan = jest.fn()
const getOpenPlanForSession = jest.fn()
const cancelPlan = jest.fn()
const getOpenGoalForSession = jest.fn()

/** The plan `createPlan` echoes back, shaped from whatever input it received. */
function planFrom(input: CreatePlanInput): AgentPlan {
  const steps = (input.steps ?? []).map((s, i) => ({
    id: `st${i}`,
    title: s.title,
    kind: s.kind,
    status: "pending" as const,
    order: i,
    dependencies: [] as string[],
    ...(s.params ? { params: s.params } : {}),
  }))
  return {
    id: "p1",
    sessionId: input.sessionId,
    title: input.title,
    source: input.source,
    executionMode: input.executionMode ?? "auto",
    steps,
    status: "awaiting_approval",
    totalSteps: steps.length,
    completedSteps: 0,
    config: (input.config ?? {}) as AgentPlan["config"],
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  } as AgentPlan
}

function ctx(over: Partial<SlashContext> = {}): SlashContext {
  return {
    args: "",
    activeSessionId: "ses_a",
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: () => {},
    openSettings: () => {},
    setPermissionMode: () => {},
    pushSystemMessage: () => {},
    ...over,
  } as SlashContext
}

beforeEach(() => {
  jest.clearAllMocks()
  createPlan.mockImplementation(async (input: CreatePlanInput) => planFrom(input))
  getOpenPlanForSession.mockResolvedValue(undefined)
  cancelPlan.mockResolvedValue(null)
  getOpenGoalForSession.mockResolvedValue(undefined)
  getPlanRuntimeMock.mockReturnValue({ createPlan, getOpenPlanForSession, cancelPlan })
  getGoalRuntimeMock.mockReturnValue({ getOpenGoalForSession })
  loadPlanConfigDefaultsMock.mockResolvedValue(undefined)
  getSessionMock.mockResolvedValue({ id: "ses_a", characterId: "char_1" })
  settingsStateMock.mockReturnValue({ settings: {} })
  teamStateMock.mockReturnValue({ teams: {}, tasks: {} })
  buildAgentRoleLlmClientMock.mockResolvedValue({ complete: jest.fn() })
})

describe("guards", () => {
  it("refuses without an active session", async () => {
    const res = await dispatchPlanSubcommand(ctx({ activeSessionId: null }))
    expect(res.system).toMatch(/Start a chat session first/)
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("refuses mid-stream", async () => {
    const res = await dispatchPlanSubcommand(ctx({ chatStatus: "streaming", args: "do a thing" }))
    expect(res.system).toMatch(/still streaming/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan (status)", () => {
  it("lists the ways to start one when there is no open plan", async () => {
    const res = await dispatchPlanSubcommand(ctx())
    expect(res.system).toMatch(/No open plan/)
    expect(res.system).toContain("/plan from-goal")
  })

  it("renders a checklist for the open plan", async () => {
    getOpenPlanForSession.mockResolvedValue({
      ...planFrom({ sessionId: "ses_a", title: "Ship", source: "manual", steps: [] }),
      status: "executing",
      totalSteps: 2,
      completedSteps: 1,
      steps: [
        {
          id: "a",
          title: "one",
          kind: "agent_turn",
          status: "completed",
          order: 0,
          dependencies: [],
        },
        {
          id: "b",
          title: "two",
          kind: "agent_turn",
          status: "in_progress",
          order: 1,
          dependencies: [],
        },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "status" }))
    expect(res.system).toContain("EXECUTING")
    expect(res.system).toContain("- [x] one")
    expect(res.system).toContain("- [~] two")
  })

  it("treats a bare `/plan` with no argument as status", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: undefined }))
    expect(res.system).toMatch(/No open plan/)
  })

  // Every status/step-status pair renders its own glyph, so a checklist is
  // readable at a glance without opening the tracker dock.
  it.each([
    ["executing", "🟢"],
    ["paused", "⏸️"],
    ["completed", "✅"],
    ["failed", "🛑"],
    ["cancelled", "⏹️"],
    ["awaiting_approval", "🕐"],
    ["draft", "•"],
  ] as const)("marks a %s plan with %s", async (status, glyph) => {
    getOpenPlanForSession.mockResolvedValue({
      ...planFrom({ sessionId: "ses_a", title: "Ship", source: "manual", steps: [] }),
      status,
    })
    expect((await dispatchPlanSubcommand(ctx({ args: "status" }))).system).toContain(glyph)
  })

  it.each([
    ["failed", "- [!]"],
    ["blocked", "- [!]"],
    ["skipped", "- [-]"],
    ["pending", "- [ ]"],
  ] as const)("marks a %s step with `%s`", async (status, glyph) => {
    getOpenPlanForSession.mockResolvedValue({
      ...planFrom({ sessionId: "ses_a", title: "Ship", source: "manual", steps: [] }),
      steps: [
        {
          id: "a",
          title: "one",
          kind: "agent_turn",
          status,
          order: 0,
          dependencies: [] as string[],
        },
      ],
    })
    expect((await dispatchPlanSubcommand(ctx({ args: "status" }))).system).toContain(`${glyph} one`)
  })
})

describe("/plan <objective> — planner_llm", () => {
  it("decomposes and creates the plan", async () => {
    decomposeIntoPlanMock.mockResolvedValue({
      sessionId: "ses_a",
      title: "Migrate auth",
      source: "planner_llm",
      executionMode: "auto",
      steps: [
        { title: "audit callers", kind: "agent_turn" },
        { title: "swap the adapter", kind: "agent_turn", dependsOn: [0] },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "migrate the auth module" }))
    expect(decomposeIntoPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_a", characterId: "char_1" })
    )
    expect(createPlan).toHaveBeenCalledWith(expect.objectContaining({ source: "planner_llm" }))
    expect(res.system).toContain("Plan created")
    expect(res.system).toContain("1. audit callers")
  })

  it("PII red-line: redacts the objective before it reaches the planner", async () => {
    decomposeIntoPlanMock.mockResolvedValue(null)
    await dispatchPlanSubcommand(ctx({ args: "email john.doe@example.com the rollout plan" }))
    const objective = decomposeIntoPlanMock.mock.calls[0][0].objective as string
    expect(objective).not.toContain("john.doe@example.com")
  })

  it("explains how to proceed when no planner model is configured", async () => {
    buildAgentRoleLlmClientMock.mockResolvedValue(null)
    const res = await dispatchPlanSubcommand(ctx({ args: "do the thing" }))
    expect(res.system).toMatch(/No planner model available/)
    expect(decomposeIntoPlanMock).not.toHaveBeenCalled()
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("reports an unusable planner response without creating a plan", async () => {
    decomposeIntoPlanMock.mockResolvedValue(null)
    const res = await dispatchPlanSubcommand(ctx({ args: "vague" }))
    expect(res.system).toMatch(/no usable steps/)
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("decomposes without a session row or app settings (no characterId pinned)", async () => {
    // A session that cannot be read must not block planning — the character
    // binding is optional context, not a precondition.
    getSessionMock.mockResolvedValue(undefined)
    settingsStateMock.mockReturnValue({})
    decomposeIntoPlanMock.mockResolvedValue({
      sessionId: "ses_a",
      title: "T",
      source: "planner_llm",
      steps: [{ title: "one", kind: "agent_turn" }],
    })
    await dispatchPlanSubcommand(ctx({ args: "do it" }))
    expect(buildAgentRoleLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "plan", session: null, appSettings: null })
    )
    expect(decomposeIntoPlanMock.mock.calls[0][0]).not.toHaveProperty("characterId")
  })

  it("announces that an auto-approved plan skipped the gate", async () => {
    createPlan.mockImplementation(async (input: CreatePlanInput) => ({
      ...planFrom(input),
      status: "approved",
    }))
    decomposeIntoPlanMock.mockResolvedValue({
      sessionId: "ses_a",
      title: "T",
      source: "planner_llm",
      steps: [{ title: "one", kind: "agent_turn" }],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "do it" }))
    expect(res.system).toMatch(/Approval is off/)
  })
})

describe("/plan new — manual", () => {
  it("splits on pipes into a title + linear steps", async () => {
    const res = await dispatchPlanSubcommand(
      ctx({ args: "new Ship v2 | write changelog | tag the release | publish" })
    )
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.source).toBe("manual")
    expect(input.title).toBe("Ship v2")
    expect(input.steps.map((s) => s.title)).toEqual([
      "write changelog",
      "tag the release",
      "publish",
    ])
    // Linear chain: every step but the first depends on its predecessor.
    expect(input.steps[0].dependsOn).toBeUndefined()
    expect(input.steps[1].dependsOn).toEqual([0])
    expect(res.system).toContain("hand-authored")
  })

  it("also accepts newline-separated steps", async () => {
    await dispatchPlanSubcommand(ctx({ args: "new Ship v2\nstep one\nstep two" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.steps.map((s) => s.title)).toEqual(["step one", "step two"])
  })

  it("prints usage when no steps are supplied", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "new just a title" }))
    expect(res.system).toMatch(/Usage:/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan from-goal — goal_projection", () => {
  it("projects the open goal's subgoals into linear agent_turn steps", async () => {
    getOpenGoalForSession.mockResolvedValue({
      id: "g1",
      sessionId: "ses_a",
      characterId: "char_1",
      safeObjective: "ship the redesign",
      subgoals: [
        { id: "sg2", text: "second", order: 1, done: false },
        { id: "sg1", text: "first", order: 0, done: false },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "from-goal" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.source).toBe("goal_projection")
    expect(input.executionMode).toBe("in_session")
    // Ordered by `order`, not array position.
    expect(input.steps.map((s) => s.title)).toEqual(["first", "second"])
    expect(input.metadata).toEqual({ goalId: "g1" })
    expect(res.system).toContain("projected from the active goal")
  })

  it("tells the user to start a goal first", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "from-goal" }))
    expect(res.system).toMatch(/No open goal/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan from-team — team_projection", () => {
  const team = { id: soloTeamId("ses_a"), name: "Solo tasks", description: "bridge tasks" }

  it("projects the solo bridge team's tasks into teammate_dispatch steps", async () => {
    teamStateMock.mockReturnValue({
      teams: { [team.id]: team },
      tasks: {
        t2: {
          id: "t2",
          teamId: team.id,
          title: "second",
          description: "",
          dependencies: ["t1"],
          order: 1,
          assignedTo: "mate_a",
        },
        t1: {
          id: "t1",
          teamId: team.id,
          title: "first",
          description: "",
          dependencies: [],
          order: 0,
          assignedTo: "any",
        },
        other: { id: "other", teamId: "team_z", title: "elsewhere", dependencies: [], order: 0 },
      },
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.source).toBe("team_projection")
    expect(input.executionMode).toBe("orchestrated")
    expect(input.steps.map((s) => s.title)).toEqual(["first", "second"])
    // `assignedTo: "any"` is not a teammate id and must not be pinned.
    expect(input.steps[0].params).toEqual({ kind: "teammate_dispatch" })
    expect(input.steps[1].params).toEqual({ kind: "teammate_dispatch", teammateId: "mate_a" })
    // Dependencies survive as index refs into the ordered list.
    expect(input.steps[1].dependsOn).toEqual([0])
    expect(res.system).toContain("projected from the team task list")
  })

  /**
   * ADR-0140 binds a conversation to a Squad with `ChatSession.squadId`, which
   * is where its task DAG actually lives. Reading only `teamId` sent every
   * Squad-bound conversation to the synthetic solo team, so `/plan from-team`
   * reported "no team tasks" for a Squad that had them.
   */
  it("prefers the Squad the conversation is handed to", async () => {
    getSessionMock.mockResolvedValue({ id: "ses_a", squadId: "squad_1", teamId: "team_real" })
    teamStateMock.mockReturnValue({
      teams: { squad_1: { id: "squad_1", name: "Review Crew" } },
      tasks: { t1: { id: "t1", teamId: "squad_1", title: "a", dependencies: [], order: 0 } },
    })
    await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect((createPlan.mock.calls[0][0] as CreatePlanInput).metadata).toEqual({
      teamId: "squad_1",
    })
  })

  it("prefers the session's own team over the solo bridge team", async () => {
    getSessionMock.mockResolvedValue({ id: "ses_a", teamId: "team_real" })
    teamStateMock.mockReturnValue({
      teams: { team_real: { id: "team_real", name: "Real team" } },
      tasks: { t1: { id: "t1", teamId: "team_real", title: "a", dependencies: [], order: 0 } },
    })
    await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect((createPlan.mock.calls[0][0] as CreatePlanInput).metadata).toEqual({
      teamId: "team_real",
    })
  })

  it("explains how to populate the team when it does not exist", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect(res.system).toMatch(/No team tasks/)
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("reports an empty team instead of creating a zero-step plan", async () => {
    teamStateMock.mockReturnValue({ teams: { [team.id]: team }, tasks: {} })
    const res = await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect(res.system).toMatch(/no tasks to project/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan to-team — reverse projection", () => {
  const upsertTask = jest.fn()
  const teamId = soloTeamId("ses_a")

  beforeEach(() => {
    upsertTask.mockReset()
    teamStateMock.mockReturnValue({
      teams: { [teamId]: { id: teamId, name: "Solo tasks" } },
      tasks: {},
      upsertTask,
    })
  })

  it("mirrors the plan's steps into team tasks, preserving ids and the DAG", async () => {
    getOpenPlanForSession.mockResolvedValue({
      id: "p1",
      title: "Ship v2",
      steps: [
        { id: "st0", title: "first", description: "", dependencies: [], order: 0 },
        { id: "st1", title: "second", description: "detail", dependencies: ["st0"], order: 1 },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).toHaveBeenCalledTimes(2)
    // Step ids become task ids, so the dependency edge survives verbatim —
    // that is the whole reason this uses upsertTask over createTask.
    expect(upsertTask.mock.calls[0][0]).toMatchObject({ id: "st0", teamId, dependencies: [] })
    expect(upsertTask.mock.calls[1][0]).toMatchObject({ id: "st1", dependencies: ["st0"] })
    expect(res.system).toContain("Projected 2 step(s)")
  })

  it("refuses without an open plan", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).not.toHaveBeenCalled()
    expect(res.system).toMatch(/No open plan to project/)
  })

  it("refuses to project a plan with no steps", async () => {
    getOpenPlanForSession.mockResolvedValue({ id: "p1", title: "Empty", steps: [] })
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).not.toHaveBeenCalled()
    expect(res.system).toMatch(/no steps to project/)
  })

  it("reports a team it could not resolve rather than dropping the steps", async () => {
    // The session points at a real (non-solo) team that is no longer in the
    // store, so `ensureSoloTeam` correctly declines to fabricate one. Writing
    // tasks against a missing team would silently lose them.
    getSessionMock.mockResolvedValue({ id: "ses_a", teamId: "team_deleted" })
    teamStateMock.mockReturnValue({ teams: {}, tasks: {}, upsertTask })
    getOpenPlanForSession.mockResolvedValue({
      id: "p1",
      title: "Ship v2",
      steps: [{ id: "st0", title: "first", dependencies: [], order: 0 }],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).not.toHaveBeenCalled()
    expect(res.system).toMatch(/Could not resolve a team/)
  })
})

describe("/plan cancel", () => {
  it.each(["cancel", "stop", "clear"])("%s cancels the open plan", async (word) => {
    getOpenPlanForSession.mockResolvedValue({
      id: "p9",
      title: "Ship",
      completedSteps: 1,
      totalSteps: 3,
    })
    const res = await dispatchPlanSubcommand(ctx({ args: word }))
    expect(cancelPlan).toHaveBeenCalledWith("p9")
    expect(res.system).toContain("1/3")
  })

  it("is a no-op without an open plan", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "cancel" }))
    expect(cancelPlan).not.toHaveBeenCalled()
    expect(res.system).toMatch(/No open plan to cancel/)
  })
})

describe("plan settings defaults", () => {
  it("merges the user's plan defaults into every created plan", async () => {
    loadPlanConfigDefaultsMock.mockResolvedValue({ requireApproval: false, maxAutoRefinements: 5 })
    await dispatchPlanSubcommand(ctx({ args: "new T | a | b" }))
    expect((createPlan.mock.calls[0][0] as CreatePlanInput).config).toEqual({
      requireApproval: false,
      maxAutoRefinements: 5,
    })
  })

  it("keeps working when the session row cannot be read", async () => {
    getSessionMock.mockRejectedValue(new Error("dexie down"))
    await dispatchPlanSubcommand(ctx({ args: "new T | a" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.characterId).toBeUndefined()
    expect(input.title).toBe("T")
  })
})

// `/plan to-workflow` / `/plan from-workflow` — the durable half of the
// plan⇄workflow conversion. The ephemeral compile that `runPlan` performs is
// never persisted; these two are.
describe("plan ⇄ workflow conversion", () => {
  it("saves the open plan as an editable workflow with a manual trigger", async () => {
    getOpenPlanForSession.mockResolvedValue({
      id: "p1",
      sessionId: "ses_1",
      title: "Ship v2",
      status: "awaiting_approval",
      config: {},
      steps: [
        {
          id: "a",
          title: "one",
          kind: "agent_turn",
          status: "pending",
          order: 0,
          dependencies: [],
        },
        {
          id: "b",
          title: "two",
          kind: "agent_turn",
          status: "pending",
          order: 1,
          dependencies: ["a"],
        },
      ],
    })
    createWorkflowMock.mockResolvedValue({ id: "wf_new", name: "Ship v2" })

    const res = await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))

    expect(createWorkflowMock).toHaveBeenCalledTimes(1)
    const draft = createWorkflowMock.mock.calls[0][0]
    expect(draft.name).toBe("Ship v2")
    expect(draft.nodes[0].type).toBe("trigger.manual")
    expect(draft.nodes).toHaveLength(3)
    expect(res.system).toContain("wf_new")
  })

  it("refuses to export when there is no open plan", async () => {
    getOpenPlanForSession.mockResolvedValue(undefined)
    const res = await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))
    expect(createWorkflowMock).not.toHaveBeenCalled()
    expect(res.system).toContain("No open plan to export")
  })

  it("wraps a workflow found by id in an approval-gated plan", async () => {
    getWorkflowMock.mockResolvedValue({ id: "wf_1", name: "Nightly report" })
    await dispatchPlanSubcommand(ctx({ args: "from-workflow wf_1" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.steps.map((s) => s.kind)).toEqual(["approval_gate", "sub_workflow"])
    expect(input.metadata).toEqual({ workflowId: "wf_1" })
  })

  it("falls back to a name search and reports an ambiguous match", async () => {
    getWorkflowMock.mockResolvedValue(undefined)
    listWorkflowsMock.mockResolvedValue([
      { id: "wf_1", name: "Nightly report" },
      { id: "wf_2", name: "Nightly digest" },
    ])
    const res = await dispatchPlanSubcommand(ctx({ args: "from-workflow nightly" }))
    expect(createPlan).not.toHaveBeenCalled()
    expect(res.system).toContain("matches 2 workflows")
  })

  it("reports a miss instead of creating an empty plan", async () => {
    getWorkflowMock.mockResolvedValue(undefined)
    listWorkflowsMock.mockResolvedValue([])
    const res = await dispatchPlanSubcommand(ctx({ args: "from-workflow nope" }))
    expect(createPlan).not.toHaveBeenCalled()
    expect(res.system).toContain("No workflow matches")
  })

  it("explains the usage when no workflow is named", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "from-workflow" }))
    expect(res.system).toContain("Usage:")
  })
})
