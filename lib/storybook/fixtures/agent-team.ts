// Storybook-only fixtures for the Agent Team subsystem (ADR-0022). Builds
// fully-typed `AgentTeam` / `AgentTeammate` records so team workspace panels
// and the plan-approval surfaces render without a live team runtime.
import type {
  AgentTeam,
  AgentTeamConfig,
  AgentTeammate,
  TeamExecutionCheckpoint,
  TeamExecutionReport,
} from "@/types/agent/agent-team"

const ZERO_TOKENS = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

const DEFAULT_CONFIG: AgentTeamConfig = {
  maxTeammates: 5,
  maxConcurrentTeammates: 3,
  executionMode: "coordinated",
  displayMode: "expanded",
  requirePlanApproval: true,
}

const CREATED_AT = new Date("2026-06-29T00:00:00.000Z")

export function buildTeammate(over: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm-lead",
    teamId: "team-1",
    name: "Lead",
    description: "Coordinates the team and proposes the plan.",
    role: "lead",
    status: "awaiting_approval",
    config: {},
    completedTaskIds: [],
    tokenUsage: { ...ZERO_TOKENS },
    progress: 0,
    createdAt: CREATED_AT,
    ...over,
  }
}

export function buildTeam(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "team-1",
    name: "Bug-fix squad",
    description: "Reproduce, fix, and ship the reducer regression.",
    task: "Fix the off-by-one in the plan reducer and add a regression test.",
    status: "planning",
    config: DEFAULT_CONFIG,
    leadId: "tm-lead",
    teammateIds: ["tm-lead", "tm-coder"],
    taskIds: [],
    messageIds: [],
    progress: 20,
    totalTokenUsage: { ...ZERO_TOKENS },
    createdAt: CREATED_AT,
    ...over,
  }
}

const T0 = Date.UTC(2026, 5, 29, 10, 0, 0)
const min = (n: number) => new Date(T0 + n * 60_000)

const REPORT_CHECKPOINTS: TeamExecutionCheckpoint[] = [
  { id: "cp-1", type: "pattern_selected", timestamp: min(0), summary: "Selected manager/worker" },
  {
    id: "cp-2",
    type: "delegation_started",
    timestamp: min(1),
    summary: "Reproduce the failing test",
    teammateId: "tm-coder",
    delegationId: "d-1",
    data: { tokens: 1200 },
  },
  {
    id: "cp-3",
    type: "delegation_completed",
    timestamp: min(4),
    summary: "Reproduced",
    teammateId: "tm-coder",
    delegationId: "d-1",
    data: { tokens: 2400 },
  },
  {
    id: "cp-4",
    type: "budget_escalated",
    timestamp: min(5),
    summary: "Requested more budget",
    data: { tokens: 800 },
  },
  {
    id: "cp-5",
    type: "delegation_started",
    timestamp: min(5),
    summary: "Patch the reducer",
    teammateId: "tm-coder",
    delegationId: "d-2",
    data: { tokens: 1500 },
  },
  {
    id: "cp-6",
    type: "delegation_failed",
    timestamp: min(9),
    summary: "Patch failed a test",
    teammateId: "tm-coder",
    delegationId: "d-2",
  },
]

export function buildReport(over: Partial<TeamExecutionReport> = {}): TeamExecutionReport {
  return {
    id: "report-1",
    teamId: "team-1",
    status: "completed",
    checkpoints: REPORT_CHECKPOINTS,
    summary: {
      completedTasks: 3,
      failedTasks: 1,
      cancelledTasks: 0,
      blockedTasks: 0,
      delegatedTasks: 2,
      approvalsRequested: 1,
      retries: 1,
      totalTokens: 5900,
      nextActions: ["Re-run the suite", "Open a PR"],
    },
    traceSessionId: "trace-1",
    createdAt: min(0),
    updatedAt: min(9),
    completedAt: min(9),
    ...over,
  }
}

export const SAMPLE_PROPOSED_PLAN = `1. Reproduce the failing test locally.
2. Trace the off-by-one in computePlanCounts.
3. Patch the reducer and add a regression test.
4. Run the full suite and open a PR.`
