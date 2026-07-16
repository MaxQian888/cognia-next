/**
 * Workflow fixture factory. These seeds are used by E2E harnesses through
 * `window.__cogniaSeedWorkflow` and by unit tests as a catalog contract.
 *
 * Each fixture is intentionally small, but every node must carry params that
 * satisfy the registered `node.data.params` schema for its workflow kind.
 */

import type { WorkflowDraft } from "@/lib/db/workflows"
import type { WorkflowEdge, WorkflowNode, WorkflowNodeKind } from "@/types/workflow/visual"

type Params = Record<string, unknown>
type Position = { x: number; y: number }
type WorkflowFixtureFactory = () => WorkflowDraft

interface FixtureAction {
  id: string
  type: WorkflowNodeKind
  label: string
  params: Params
  position?: Position
}

function workflowNode(
  id: string,
  type: WorkflowNodeKind,
  label: string,
  params: Params,
  position: Position
): WorkflowNode {
  return {
    id,
    type,
    typeVersion: 1,
    position,
    data: { label, params },
  }
}

function manualTrigger(id = "n_trigger"): WorkflowNode {
  return workflowNode(id, "trigger.manual", "Manual", {}, { x: 80, y: 120 })
}

function chain(name: string, actions: FixtureAction[]): WorkflowDraft {
  const nodes: WorkflowNode[] = [
    manualTrigger(),
    ...actions.map((action, index) =>
      workflowNode(
        action.id,
        action.type,
        action.label,
        action.params,
        action.position ?? { x: 320 + index * 240, y: 120 }
      )
    ),
  ]

  const edges: WorkflowEdge[] = []
  for (let index = 0; index < nodes.length - 1; index++) {
    edges.push({ id: `e_${index}`, source: nodes[index].id, target: nodes[index + 1].id })
  }

  return { name, nodes, edges }
}

function single(name: string, action: FixtureAction): WorkflowDraft {
  return chain(name, [action])
}

function triggerOnly(
  name: string,
  type: WorkflowNodeKind,
  label: string,
  params: Params
): WorkflowDraft {
  return {
    name,
    nodes: [workflowNode("n_trigger", type, label, params, { x: 80, y: 120 })],
    edges: [],
  }
}

const SESSION_ID = "sess_fixture"
const CHARACTER_ID = "char_fixture"
const GOAL_ID = "goal_fixture"
const TEMPLATE_ID = "goal_template_fixture"
const PLAN_ID = "plan_fixture"
const STEP_ID = "step_fixture"
const TASK_ID = "task_fixture"
const EXECUTION_ID = "execution_fixture"
const REPO_FULL_NAME = "owner/repo"
const VALID_PLAN_STEPS = '[{"title":"Draft answer","kind":"agent_turn"}]'
const VALID_TASK_EXPORT = '{"version":1,"tasks":[]}'

const FIXTURES = {
  // Existing fixtures kept for back-compat.
  "manual-ai": () =>
    single("E2E Manual AI", {
      id: "n_prompt",
      type: "ai.prompt",
      label: "Prompt",
      params: { provider: "stub", model: "stub-model", userPrompt: "Hello" },
    }),
  branch: () => ({
    name: "E2E Branch",
    nodes: [
      manualTrigger(),
      workflowNode("n_branch", "flow.branch", "Branch", { condition: "true" }, { x: 360, y: 120 }),
      workflowNode(
        "n_true",
        "flow.set",
        "True path",
        { variable: "result", value: "yes" },
        { x: 640, y: 40 }
      ),
      workflowNode(
        "n_false",
        "flow.set",
        "False path",
        { variable: "result", value: "no" },
        { x: 640, y: 200 }
      ),
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_branch" },
      { id: "e2", source: "n_branch", sourceHandle: "true", target: "n_true" },
      { id: "e3", source: "n_branch", sourceHandle: "false", target: "n_false" },
    ],
  }),
  cycle: () => ({
    name: "E2E Cycle",
    nodes: [
      manualTrigger("n_a"),
      workflowNode("n_b", "flow.set", "B", { variable: "k", value: "v" }, { x: 360, y: 120 }),
    ],
    edges: [{ id: "e1", source: "n_a", target: "n_b" }],
  }),
  "multi-step": () => ({
    name: "E2E Multi-step",
    nodes: [
      manualTrigger(),
      workflowNode(
        "n_prompt",
        "ai.prompt",
        "Prompt",
        { provider: "stub", model: "stub-model", userPrompt: "Hello" },
        { x: 320, y: 120 }
      ),
      workflowNode(
        "n_transform",
        "data.transform",
        "Transform",
        { expression: "input.text.toUpperCase()" },
        { x: 560, y: 120 }
      ),
      workflowNode("n_branch", "flow.branch", "Decide", { condition: "true" }, { x: 800, y: 120 }),
      workflowNode(
        "n_true",
        "flow.set",
        "OK",
        { variable: "status", value: "ok" },
        { x: 1040, y: 40 }
      ),
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_prompt" },
      { id: "e2", source: "n_prompt", target: "n_transform" },
      { id: "e3", source: "n_transform", target: "n_branch" },
      { id: "e4", source: "n_branch", sourceHandle: "true", target: "n_true" },
    ],
  }),

  // AI.
  "ai-prompt": () =>
    single("E2E AI Prompt", {
      id: "n_prompt",
      type: "ai.prompt",
      label: "Prompt",
      params: {
        provider: "anthropic",
        model: "claude-3-haiku",
        apiKey: "test",
        userPrompt: "Say hi",
        temperature: 0,
      },
    }),
  "ai-classify": () =>
    single("E2E AI Classify", {
      id: "n_classify",
      type: "ai.classify",
      label: "Classify",
      params: {
        provider: "anthropic",
        model: "claude-3-haiku",
        apiKey: "test",
        input: "Order is late",
        labelsRaw: "complaint,praise",
        labels: ["complaint", "praise"],
      },
    }),
  "ai-extract": () =>
    single("E2E AI Extract", {
      id: "n_extract",
      type: "ai.extract",
      label: "Extract",
      params: {
        provider: "anthropic",
        model: "claude-3-haiku",
        apiKey: "test",
        input: "Order #1234 for John",
        schemaJson: '{"orderId":"string","customer":"string"}',
      },
    }),
  "ai-embed": () =>
    single("E2E AI Embed", {
      id: "n_embed",
      type: "ai.embed",
      label: "Embed",
      params: { provider: "anthropic", model: "voyage-3", apiKey: "test", input: "vector me" },
    }),

  // Data.
  "data-transform": () =>
    single("E2E Data Transform", {
      id: "n_t",
      type: "data.transform",
      label: "Transform",
      params: { expression: "input.value * 2" },
    }),
  "data-code": () =>
    single("E2E Data Code", {
      id: "n_c",
      type: "data.code",
      label: "Code",
      params: { code: "return { doubled: input.value * 2 }" },
    }),
  "data-template": () =>
    single("E2E Data Template", {
      id: "n_tpl",
      type: "data.template",
      label: "Template",
      params: { template: "Hello {{ input.name }}" },
    }),

  // Flow.
  "flow-branch": () =>
    single("E2E Flow Branch", {
      id: "n_br",
      type: "flow.branch",
      label: "Branch",
      params: { condition: "input.ok" },
    }),
  "flow-switch": () => ({
    name: "E2E Flow Switch",
    nodes: [
      manualTrigger(),
      workflowNode(
        "n_sw",
        "flow.switch",
        "Switch",
        {
          subject: "input.kind",
          cases: [
            { value: "alpha", label: "alpha" },
            { value: "beta", label: "beta" },
          ],
          defaultLabel: "default",
        },
        { x: 320, y: 120 }
      ),
      workflowNode(
        "n_alpha",
        "flow.set",
        "Alpha",
        { variable: "out", value: "A" },
        { x: 600, y: 40 }
      ),
      workflowNode(
        "n_beta",
        "flow.set",
        "Beta",
        { variable: "out", value: "B" },
        { x: 600, y: 160 }
      ),
      workflowNode(
        "n_default",
        "flow.set",
        "Default",
        { variable: "out", value: "D" },
        { x: 600, y: 280 }
      ),
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_sw" },
      { id: "e2", source: "n_sw", sourceHandle: "alpha", target: "n_alpha" },
      { id: "e3", source: "n_sw", sourceHandle: "beta", target: "n_beta" },
      { id: "e4", source: "n_sw", sourceHandle: "default", target: "n_default" },
    ],
  }),
  "flow-split-join": () => ({
    name: "E2E Flow Split Join",
    nodes: [
      manualTrigger(),
      workflowNode(
        "n_split",
        "flow.split",
        "Split",
        { branchLabels: ["alpha", "beta"] },
        { x: 320, y: 120 }
      ),
      workflowNode("n_a", "flow.set", "A", { variable: "a", value: "1" }, { x: 560, y: 40 }),
      workflowNode("n_b", "flow.set", "B", { variable: "b", value: "2" }, { x: 560, y: 200 }),
      workflowNode("n_join", "flow.join", "Join", { joinPolicy: "all" }, { x: 800, y: 120 }),
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_split" },
      { id: "e2", source: "n_split", sourceHandle: "alpha", target: "n_a" },
      { id: "e3", source: "n_split", sourceHandle: "beta", target: "n_b" },
      { id: "e4", source: "n_a", target: "n_join" },
      { id: "e5", source: "n_b", target: "n_join" },
    ],
  }),
  "flow-loop": () =>
    chain("E2E Flow Loop", [
      {
        id: "n_loop",
        type: "flow.loop",
        label: "Loop",
        params: { mode: "forEach", source: "{{ input.items }}", maxIterations: 3 },
      },
      {
        id: "n_body",
        type: "flow.set",
        label: "Iter",
        params: { variable: "iter", value: "{{ item }}" },
      },
    ]),
  "flow-wait": () =>
    single("E2E Flow Wait", {
      id: "n_wait",
      type: "flow.wait",
      label: "Wait",
      params: { mode: "duration", durationMs: 100 },
    }),
  "flow-set": () =>
    single("E2E Flow Set", {
      id: "n_set",
      type: "flow.set",
      label: "Set",
      params: { variable: "x", value: "42" },
    }),
  "flow-subworkflow": () =>
    single("E2E Flow Subworkflow", {
      id: "n_sub",
      type: "flow.subworkflow",
      label: "Sub",
      params: { workflowId: "wf_child_placeholder" },
    }),
  "flow-catch": () =>
    single("E2E Flow Catch", {
      id: "n_catch",
      type: "flow.catch",
      label: "Catch",
      params: { scope: "workflow" },
    }),
  "flow-break": () =>
    single("E2E Flow Break", {
      id: "n_break",
      type: "flow.break",
      label: "Break",
      params: {},
    }),
  "flow-continue": () =>
    single("E2E Flow Continue", {
      id: "n_continue",
      type: "flow.continue",
      label: "Continue",
      params: {},
    }),

  // IO.
  "io-http": () =>
    single("E2E IO HTTP", {
      id: "n_http",
      type: "io.http",
      label: "HTTP",
      params: { method: "GET", url: "https://example.test/data" },
    }),
  "io-webhook-respond": () =>
    single("E2E IO Webhook Respond", {
      id: "n_resp",
      type: "io.webhook.respond",
      label: "Respond",
      params: { status: 200, body: '{"ok":true}' },
    }),

  // Triggers.
  "trigger-cron": () =>
    triggerOnly("E2E Cron Trigger", "trigger.cron", "Cron", {
      cron: "0 9 * * *",
      timezone: "UTC",
    }),
  "trigger-webhook": () =>
    triggerOnly("E2E Webhook Trigger", "trigger.webhook", "Webhook", {
      path: "hooks/test",
      method: "POST",
      hmacSecret: "shh",
    }),
  "trigger-chat": () =>
    triggerOnly("E2E Chat Trigger", "trigger.chat.message", "Chat", {
      characterId: CHARACTER_ID,
      sessionId: SESSION_ID,
    }),
  "trigger-connector-inbound": () =>
    triggerOnly("E2E Connector Trigger", "trigger.connector.inbound", "Connector Inbound", {
      adapterId: "lark",
      conversationKey: "chat-1",
    }),
  "trigger-github-webhook": () =>
    triggerOnly("E2E GitHub Webhook Trigger", "trigger.github.webhook", "GitHub Webhook", {
      path: "github/pr",
      method: "POST",
      hmacSecret: "shh",
    }),
  "trigger-goal-completed": () =>
    triggerOnly("E2E Goal Completed Trigger", "trigger.goal.completed", "Goal Completed", {
      status: "completed",
    }),
  "trigger-desktop-event": () =>
    triggerOnly("E2E Desktop Event Trigger", "trigger.desktop.event", "Desktop Event", {
      kinds: ["focus-changed"],
    }),
  "trigger-team": () => triggerOnly("E2E Team Trigger", "trigger.team", "Team Trigger", {}),
  "trigger-terminal-command": () =>
    triggerOnly("E2E Terminal Command Trigger", "trigger.terminal.command", "Terminal Command", {
      status: "success",
      commandContains: "pnpm test",
    }),

  // Character and agent actions.
  "action-character-send": () =>
    single("E2E Character Send", {
      id: "n_send",
      type: "action.character.send",
      label: "Send",
      params: { characterId: CHARACTER_ID, sessionId: SESSION_ID, content: "Hi" },
    }),
  "action-character-create": () =>
    single("E2E Character Create", {
      id: "n_create",
      type: "action.character.create",
      label: "Create",
      params: { name: "E2E Char", description: "demo", systemPrompt: "Be helpful" },
    }),
  "action-character-update": () =>
    single("E2E Character Update", {
      id: "n_upd",
      type: "action.character.update",
      label: "Update",
      params: { characterId: CHARACTER_ID, patch: { name: "Renamed" } },
    }),
  "action-agent-turn": () =>
    single("E2E Agent Turn", {
      id: "n_agent",
      type: "action.agent.turn",
      label: "Agent Turn",
      params: {
        prompt: "Summarize the workflow run",
        characterId: CHARACTER_ID,
        maxTurns: 3,
        toolsEnabled: true,
      },
    }),

  // Goal actions.
  "action-goal-create": () =>
    single("E2E Goal Create", {
      id: "n_goal_create",
      type: "action.goal.create",
      label: "Create Goal",
      params: { sessionId: SESSION_ID, rawObjective: "Ship workflow fixtures" },
    }),
  "action-goal-get": () =>
    single("E2E Goal Get", {
      id: "n_goal_get",
      type: "action.goal.get",
      label: "Get Goal",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-list": () =>
    single("E2E Goal List", {
      id: "n_goal_list",
      type: "action.goal.list",
      label: "List Goals",
      params: { mode: "session", sessionId: SESSION_ID, limit: 10 },
    }),
  "action-goal-events": () =>
    single("E2E Goal Events", {
      id: "n_goal_events",
      type: "action.goal.events",
      label: "Goal Events",
      params: { goalId: GOAL_ID, limit: 10 },
    }),
  "action-goal-update-objective": () =>
    single("E2E Goal Update Objective", {
      id: "n_goal_objective",
      type: "action.goal.updateObjective",
      label: "Update Objective",
      params: { goalId: GOAL_ID, rawObjective: "Refined objective" },
    }),
  "action-goal-pause": () =>
    single("E2E Goal Pause", {
      id: "n_goal_pause",
      type: "action.goal.pause",
      label: "Pause Goal",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-resume": () =>
    single("E2E Goal Resume", {
      id: "n_goal_resume",
      type: "action.goal.resume",
      label: "Resume Goal",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-stop": () =>
    single("E2E Goal Stop", {
      id: "n_goal_stop",
      type: "action.goal.stop",
      label: "Stop Goal",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-preempt": () =>
    single("E2E Goal Preempt", {
      id: "n_goal_preempt",
      type: "action.goal.preempt",
      label: "Preempt Goal",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-update-config": () =>
    single("E2E Goal Update Config", {
      id: "n_goal_config",
      type: "action.goal.updateConfig",
      label: "Update Goal Config",
      params: { goalId: GOAL_ID, config: { priority: "high" } },
    }),
  "action-goal-decompose-subgoals": () =>
    single("E2E Goal Decompose Subgoals", {
      id: "n_goal_decompose",
      type: "action.goal.decomposeSubgoals",
      label: "Decompose Goal",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-toggle-subgoal": () =>
    single("E2E Goal Toggle Subgoal", {
      id: "n_goal_toggle",
      type: "action.goal.toggleSubgoal",
      label: "Toggle Subgoal",
      params: { goalId: GOAL_ID, subgoalId: "subgoal_fixture" },
    }),
  "action-goal-clear-subgoals": () =>
    single("E2E Goal Clear Subgoals", {
      id: "n_goal_clear",
      type: "action.goal.clearSubgoals",
      label: "Clear Subgoals",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-delete": () =>
    single("E2E Goal Delete", {
      id: "n_goal_delete",
      type: "action.goal.delete",
      label: "Delete Goal",
      params: { goalId: GOAL_ID },
    }),
  "action-goal-analytics": () =>
    single("E2E Goal Analytics", {
      id: "n_goal_analytics",
      type: "action.goal.analytics",
      label: "Goal Analytics",
      params: { scope: "session", sessionId: SESSION_ID, windowDays: 7 },
    }),
  "action-goal-template-list": () =>
    single("E2E Goal Template List", {
      id: "n_goal_template_list",
      type: "action.goal.template.list",
      label: "List Goal Templates",
      params: { includeBuiltIn: true, limit: 10 },
    }),
  "action-goal-template-create-goal": () =>
    single("E2E Goal Template Create Goal", {
      id: "n_goal_template_create",
      type: "action.goal.template.createGoal",
      label: "Create Goal From Template",
      params: { templateId: TEMPLATE_ID, sessionId: SESSION_ID },
    }),
  "action-goal-template-upsert": () =>
    single("E2E Goal Template Upsert", {
      id: "n_goal_template_upsert",
      type: "action.goal.template.upsert",
      label: "Upsert Goal Template",
      params: {
        templateId: TEMPLATE_ID,
        title: "Fixture Template",
        objectiveText: "Complete fixture coverage",
      },
    }),
  "action-goal-template-favorite": () =>
    single("E2E Goal Template Favorite", {
      id: "n_goal_template_favorite",
      type: "action.goal.template.favorite",
      label: "Favorite Goal Template",
      params: { templateId: TEMPLATE_ID, isFavorite: true },
    }),
  "action-goal-template-delete": () =>
    single("E2E Goal Template Delete", {
      id: "n_goal_template_delete",
      type: "action.goal.template.delete",
      label: "Delete Goal Template",
      params: { templateId: TEMPLATE_ID },
    }),

  // Team actions.
  "action-team-run": () =>
    single("E2E Team Run", {
      id: "n_run",
      type: "action.team.run",
      label: "Run",
      params: { teamId: "team_fixture", goal: "Run the fixture task" },
    }),
  "action-team-create": () =>
    single("E2E Team Create", {
      id: "n_tc",
      type: "action.team.create",
      label: "Create",
      // The executor (and `createTeam`) reject a team with zero members, so the
      // fixture seeds one. `mention_round_robin` (the default orchestration) is
      // valid with a single member and needs no supervisor.
      params: {
        name: "E2E Team",
        description: "demo",
        members: [{ characterId: "char_fixture", role: "member" }],
      },
    }),
  "action-team-update": () =>
    single("E2E Team Update", {
      id: "n_tu",
      type: "action.team.update",
      label: "Update",
      params: { teamId: "team_fixture", patch: { name: "Renamed" } },
    }),
  "action-team-task-dispatch": () =>
    single("E2E Team Task Dispatch", {
      id: "n_team_dispatch",
      type: "action.team.task.dispatch",
      label: "Dispatch Team Task",
      params: {
        teamId: "team_fixture",
        taskId: "task_fixture",
        title: "Review output",
        description: "Inspect the generated workflow output.",
      },
    }),

  // Plan actions.
  "action-plan-create": () =>
    single("E2E Plan Create", {
      id: "n_plan_create",
      type: "action.plan.create",
      label: "Create Plan",
      params: {
        sessionId: SESSION_ID,
        title: "Ship the plan",
        stepsJson: VALID_PLAN_STEPS,
      },
    }),
  "action-plan-get": () =>
    single("E2E Plan Get", {
      id: "n_plan_get",
      type: "action.plan.get",
      label: "Get Plan",
      params: { planId: PLAN_ID },
    }),
  "action-plan-list": () =>
    single("E2E Plan List", {
      id: "n_plan_list",
      type: "action.plan.list",
      label: "List Plans",
      params: { mode: "session", sessionId: SESSION_ID, limit: 10 },
    }),
  "action-plan-events": () =>
    single("E2E Plan Events", {
      id: "n_plan_events",
      type: "action.plan.events",
      label: "Plan Events",
      params: { planId: PLAN_ID, limit: 10 },
    }),
  "action-plan-update-draft": () =>
    single("E2E Plan Update Draft", {
      id: "n_plan_update",
      type: "action.plan.updateDraft",
      label: "Update Plan Draft",
      params: { planId: PLAN_ID, title: "Updated plan" },
    }),
  "action-plan-approve": () =>
    single("E2E Plan Approve", {
      id: "n_plan_approve",
      type: "action.plan.approve",
      label: "Approve Plan",
      params: { planId: PLAN_ID },
    }),
  "action-plan-reject": () =>
    single("E2E Plan Reject", {
      id: "n_plan_reject",
      type: "action.plan.reject",
      label: "Reject Plan",
      params: { planId: PLAN_ID, feedback: "Needs smaller scope" },
    }),
  "action-plan-refine": () =>
    single("E2E Plan Refine", {
      id: "n_plan_refine",
      type: "action.plan.refine",
      label: "Refine Plan",
      params: { planId: PLAN_ID, refinementType: "repair", trigger: "manual" },
    }),
  "action-plan-pause": () =>
    single("E2E Plan Pause", {
      id: "n_plan_pause",
      type: "action.plan.pause",
      label: "Pause Plan",
      params: { planId: PLAN_ID },
    }),
  "action-plan-resume": () =>
    single("E2E Plan Resume", {
      id: "n_plan_resume",
      type: "action.plan.resume",
      label: "Resume Plan",
      params: { planId: PLAN_ID },
    }),
  "action-plan-cancel": () =>
    single("E2E Plan Cancel", {
      id: "n_plan_cancel",
      type: "action.plan.cancel",
      label: "Cancel Plan",
      params: { planId: PLAN_ID },
    }),
  "action-plan-delete": () =>
    single("E2E Plan Delete", {
      id: "n_plan_delete",
      type: "action.plan.delete",
      label: "Delete Plan",
      params: { planId: PLAN_ID },
    }),
  "action-plan-run": () =>
    single("E2E Plan Run", {
      id: "n_plan_run",
      type: "action.plan.run",
      label: "Run Plan",
      params: { planId: PLAN_ID },
    }),
  "action-plan-set-step-status": () =>
    single("E2E Plan Set Step Status", {
      id: "n_plan_step_status",
      type: "action.plan.setStepStatus",
      label: "Set Step Status",
      params: { planId: PLAN_ID, stepId: STEP_ID, status: "completed", result: "ok" },
    }),

  // Scheduler actions.
  "action-scheduler-task-create": () =>
    single("E2E Scheduler Task Create", {
      id: "n_scheduler_create",
      type: "action.scheduler.task.create",
      label: "Create Scheduler Task",
      params: {
        name: "Nightly agent",
        type: "agent",
        triggerType: "cron",
        cronExpression: "0 1 * * *",
        payloadJson: '{"prompt":"check status"}',
      },
    }),
  "action-scheduler-task-get": () =>
    single("E2E Scheduler Task Get", {
      id: "n_scheduler_get",
      type: "action.scheduler.task.get",
      label: "Get Scheduler Task",
      params: { taskId: TASK_ID },
    }),
  "action-scheduler-task-list": () =>
    single("E2E Scheduler Task List", {
      id: "n_scheduler_list",
      type: "action.scheduler.task.list",
      label: "List Scheduler Tasks",
      params: { statuses: ["active"], types: ["agent"], tags: ["nightly"], limit: 10 },
    }),
  "action-scheduler-task-update": () =>
    single("E2E Scheduler Task Update", {
      id: "n_scheduler_update",
      type: "action.scheduler.task.update",
      label: "Update Scheduler Task",
      params: { taskId: TASK_ID, status: "paused" },
    }),
  "action-scheduler-task-pause": () =>
    single("E2E Scheduler Task Pause", {
      id: "n_scheduler_pause",
      type: "action.scheduler.task.pause",
      label: "Pause Scheduler Task",
      params: { taskId: TASK_ID },
    }),
  "action-scheduler-task-resume": () =>
    single("E2E Scheduler Task Resume", {
      id: "n_scheduler_resume",
      type: "action.scheduler.task.resume",
      label: "Resume Scheduler Task",
      params: { taskId: TASK_ID },
    }),
  "action-scheduler-task-delete": () =>
    single("E2E Scheduler Task Delete", {
      id: "n_scheduler_delete",
      type: "action.scheduler.task.delete",
      label: "Delete Scheduler Task",
      params: { taskId: TASK_ID },
    }),
  "action-scheduler-task-run-now": () =>
    single("E2E Scheduler Task Run Now", {
      id: "n_scheduler_run_now",
      type: "action.scheduler.task.runNow",
      label: "Run Scheduler Task Now",
      params: { taskId: TASK_ID },
    }),
  "action-scheduler-task-executions": () =>
    single("E2E Scheduler Task Executions", {
      id: "n_scheduler_executions",
      type: "action.scheduler.task.executions",
      label: "Scheduler Task Executions",
      params: { taskId: TASK_ID, limit: 10 },
    }),
  "action-scheduler-task-backfill": () =>
    single("E2E Scheduler Task Backfill", {
      id: "n_scheduler_backfill",
      type: "action.scheduler.task.backfill",
      label: "Backfill Scheduler Task",
      params: {
        taskId: TASK_ID,
        start: "2026-06-01T00:00:00Z",
        end: "2026-06-02T00:00:00Z",
      },
    }),
  "action-scheduler-task-export": () =>
    single("E2E Scheduler Task Export", {
      id: "n_scheduler_export",
      type: "action.scheduler.task.export",
      label: "Export Scheduler Tasks",
      params: { taskIdsRaw: TASK_ID },
    }),
  "action-scheduler-task-import": () =>
    single("E2E Scheduler Task Import", {
      id: "n_scheduler_import",
      type: "action.scheduler.task.import",
      label: "Import Scheduler Tasks",
      params: { dataJson: VALID_TASK_EXPORT, mode: "merge" },
    }),
  "action-scheduler-status": () =>
    single("E2E Scheduler Status", {
      id: "n_scheduler_status",
      type: "action.scheduler.status",
      label: "Scheduler Status",
      params: {},
    }),
  "action-scheduler-statistics": () =>
    single("E2E Scheduler Statistics", {
      id: "n_scheduler_stats",
      type: "action.scheduler.statistics",
      label: "Scheduler Statistics",
      params: {},
    }),
  "action-scheduler-upcoming": () =>
    single("E2E Scheduler Upcoming", {
      id: "n_scheduler_upcoming",
      type: "action.scheduler.upcoming",
      label: "Scheduler Upcoming",
      params: { limit: 10 },
    }),
  "action-scheduler-executions-recent": () =>
    single("E2E Scheduler Recent Executions", {
      id: "n_scheduler_recent",
      type: "action.scheduler.executions.recent",
      label: "Scheduler Recent Executions",
      params: { limit: 10 },
    }),
  "action-scheduler-execution-get": () =>
    single("E2E Scheduler Execution Get", {
      id: "n_scheduler_execution_get",
      type: "action.scheduler.execution.get",
      label: "Get Scheduler Execution",
      params: { executionId: EXECUTION_ID },
    }),
  "action-scheduler-event-trigger": () =>
    single("E2E Scheduler Event Trigger", {
      id: "n_scheduler_event",
      type: "action.scheduler.event.trigger",
      label: "Trigger Scheduler Event",
      params: {
        eventType: "workflow.completed",
        eventSource: "fixture",
        payloadJson: '{"ok":true}',
      },
    }),

  // Terminal actions.
  "action-system-terminal": () =>
    single("E2E System Terminal", {
      id: "n_terminal",
      type: "action.system.terminal",
      label: "Run Terminal Command",
      params: { command: "pnpm test", cwd: "D:/Project/cognia-next" },
    }),
  "action-terminal-session-open": () =>
    single("E2E Terminal Session Open", {
      id: "n_terminal_open",
      type: "action.terminal.session.open",
      label: "Open Terminal Session",
      params: { cwd: "D:/Project/cognia-next" },
    }),
  "action-terminal-session-run": () =>
    single("E2E Terminal Session Run", {
      id: "n_terminal_run",
      type: "action.terminal.session.run",
      label: "Run In Terminal Session",
      params: { sessionId: "terminal_session_fixture", command: "pnpm lint" },
    }),
  "action-terminal-session-close": () =>
    single("E2E Terminal Session Close", {
      id: "n_terminal_close",
      type: "action.terminal.session.close",
      label: "Close Terminal Session",
      params: { sessionId: "terminal_session_fixture" },
    }),
  "action-terminal-script": () =>
    single("E2E Terminal Script", {
      id: "n_terminal_script",
      type: "action.terminal.script",
      label: "Run Script",
      params: { scriptPath: "scripts/fixture-smoke.ps1", interpreter: "powershell" },
    }),
  "action-terminal-read-recent": () =>
    single("E2E Terminal Read Recent", {
      id: "n_terminal_read_recent",
      type: "action.terminal.readRecent",
      label: "Read Recent Terminal Commands",
      params: { tabId: "terminal_tab_fixture", lineLimit: 10 },
    }),
  "action-terminal-wait-for-exit": () =>
    single("E2E Terminal Wait For Exit", {
      id: "n_terminal_wait",
      type: "action.terminal.waitForExit",
      label: "Wait For Terminal Exit",
      params: { tabId: "terminal_tab_fixture", timeoutSec: 30 },
    }),

  // Skill actions.
  "action-skill-invoke": () =>
    single("E2E Skill Invoke", {
      id: "n_si",
      type: "action.skill.invoke",
      label: "Invoke",
      params: { skillIds: "skill_fixture" },
    }),
  "action-skill-upsert": () =>
    single("E2E Skill Upsert", {
      id: "n_su",
      type: "action.skill.upsert",
      label: "Upsert",
      params: { name: "E2E Skill", description: "demo", content: "do thing" },
    }),

  // Twin and memory actions.
  "action-twin-rag": () =>
    single("E2E Twin RAG", {
      id: "n_rag",
      type: "action.twin.rag",
      label: "RAG",
      params: { twinId: "twin_fixture", query: "what is x" },
    }),
  "action-twin-ingest": () =>
    single("E2E Twin Ingest", {
      id: "n_ing",
      type: "action.twin.ingest",
      label: "Ingest",
      params: {
        twinId: "twin_fixture",
        sourceMode: "fetch",
        url: "https://example.test/doc",
      },
    }),
  "action-memory-recall": () =>
    single("E2E Memory Recall", {
      id: "n_memory_recall",
      type: "action.memory.recall",
      label: "Recall Memory",
      params: { query: "project status", topK: 5, scope: "global", types: ["semantic"] },
    }),
  "action-memory-store": () =>
    single("E2E Memory Store", {
      id: "n_memory_store",
      type: "action.memory.store",
      label: "Store Memory",
      params: {
        text: "The workflow fixture library covers goal nodes.",
        scope: "global",
        type: "semantic",
        importance: 5,
        provenance: "explicit",
        piiGate: "redact",
      },
    }),

  // Connector actions.
  "action-connector-send": () =>
    single("E2E Connector Send", {
      id: "n_cs",
      type: "action.connector.send",
      label: "Send",
      params: { adapterId: "lark", conversationKey: "chat-1", content: "hello" },
    }),
  "action-connector-draft": () =>
    single("E2E Connector Draft", {
      id: "n_cd",
      type: "action.connector.draft",
      label: "Draft",
      params: {
        conversationKey: "chat-1",
        sessionId: SESSION_ID,
        content: "draft",
      },
    }),

  // MCP and plugin actions.
  "action-mcp-invoke": () =>
    single("E2E MCP Invoke", {
      id: "n_mcp",
      type: "action.mcp.invokeTool",
      label: "MCP",
      params: { serverId: "mcp_test", toolName: "say_hello", args: {} },
    }),
  "action-plugin-invoke": () =>
    single("E2E Plugin Invoke", {
      id: "n_pi",
      type: "action.plugin.invoke",
      label: "Plugin",
      params: { pluginId: "p_test", mode: "tool", toolName: "echo", args: { text: "hi" } },
    }),

  // GitHub actions.
  "action-github-open-pr": () =>
    single("E2E GH Open PR", {
      id: "n_pr",
      type: "action.github.openPr",
      label: "Open PR",
      params: {
        repoFullName: REPO_FULL_NAME,
        head: "feat/fixture",
        base: "main",
        title: "Fixture PR",
        body: "Seeded by fixture",
      },
    }),
  "action-github-close-pr": () =>
    single("E2E GH Close PR", {
      id: "n_cl",
      type: "action.github.closePr",
      label: "Close PR",
      params: { repoFullName: REPO_FULL_NAME, prNumber: 1 },
    }),
  "action-github-merge-pr": () =>
    single("E2E GH Merge PR", {
      id: "n_mg",
      type: "action.github.mergePr",
      label: "Merge PR",
      params: { repoFullName: REPO_FULL_NAME, prNumber: 1, mergeMethod: "squash" },
    }),
  "action-github-review-pr": () =>
    single("E2E GH Review PR", {
      id: "n_rv",
      type: "action.github.reviewPr",
      label: "Review",
      params: { repoFullName: REPO_FULL_NAME, prNumber: 1, event: "COMMENT", body: "lgtm" },
    }),
  "action-github-review-pr-inline": () =>
    single("E2E GH Review PR Inline", {
      id: "n_rvi",
      type: "action.github.reviewPrInline",
      label: "Inline Review",
      params: {
        repoFullName: REPO_FULL_NAME,
        prNumber: 1,
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "sk-test",
        maxFiles: 10,
      },
    }),
  "action-github-comment-pr": () =>
    single("E2E GH Comment PR", {
      id: "n_cpr",
      type: "action.github.commentPr",
      label: "Comment PR",
      // Distinct from the comment-issue fixture's body: both nodes POST to
      // /issues/1/comments on the SHARED github mock, and parallel spec
      // workers must be able to tell their own capture apart.
      params: { repoFullName: REPO_FULL_NAME, prNumber: 1, body: "note (pr)" },
    }),
  "action-github-comment-issue": () =>
    single("E2E GH Comment Issue", {
      id: "n_ci",
      type: "action.github.commentIssue",
      label: "Comment Issue",
      params: { repoFullName: REPO_FULL_NAME, issueNumber: 1, body: "note (issue)" },
    }),
  "action-github-label-issue": () =>
    single("E2E GH Label Issue", {
      id: "n_lab",
      type: "action.github.labelIssue",
      label: "Label Issue",
      params: { repoFullName: REPO_FULL_NAME, issueNumber: 1, add: ["bug"] },
    }),
  "action-github-close-issue": () =>
    single("E2E GH Close Issue", {
      id: "n_clo",
      type: "action.github.closeIssue",
      label: "Close Issue",
      params: { repoFullName: REPO_FULL_NAME, issueNumber: 1, reason: "completed" },
    }),
  "action-github-create-release": () =>
    single("E2E GH Create Release", {
      id: "n_rel",
      type: "action.github.createRelease",
      label: "Create Release",
      params: { repoFullName: REPO_FULL_NAME, tag: "v1.0.0", name: "v1.0.0", body: "notes" },
    }),
  "action-github-generate-changelog": () =>
    single("E2E GH Generate Changelog", {
      id: "n_chg",
      type: "action.github.generateChangelog",
      label: "Generate Changelog",
      params: { repoFullName: REPO_FULL_NAME, since: "v0.9.0", currentVersion: "v1.0.0" },
    }),
  "action-github-push-tag": () =>
    single("E2E GH Push Tag", {
      id: "n_tag",
      type: "action.github.pushTag",
      label: "Push Tag",
      params: { repoFullName: REPO_FULL_NAME, tag: "v1.0.0", sha: "abcd1234" },
    }),
  "action-github-run-issue-loop": () =>
    single("E2E GH Issue Loop", {
      id: "n_il",
      type: "action.github.runIssueLoop",
      label: "Issue Loop",
      params: { repoFullName: REPO_FULL_NAME, issueNumber: 1, worktreeMode: "local" },
    }),

  // Local Git actions.
  "action-git-stage": () =>
    single("E2E Git Stage", {
      id: "n_gstage",
      type: "action.git.stage",
      label: "Git Stage",
      params: { repoPath: "/repo", paths: ["src/a.ts"] },
    }),
  "action-git-commit": () =>
    single("E2E Git Commit", {
      id: "n_gcommit",
      type: "action.git.commit",
      label: "Git Commit",
      params: { repoPath: "/repo", message: "chore: e2e commit", signoff: false },
    }),
  "action-git-push": () =>
    single("E2E Git Push", {
      id: "n_gpush",
      type: "action.git.push",
      label: "Git Push",
      params: { repoPath: "/repo", remote: "origin", branch: "main", setUpstream: false },
    }),
  "action-git-branch": () =>
    single("E2E Git Branch", {
      id: "n_gbranch",
      type: "action.git.branch",
      label: "Git Branch",
      params: { repoPath: "/repo", name: "feat/e2e", checkout: true, from: "main" },
    }),

  // OCR.
  "ocr-extract": () =>
    single("E2E OCR Extract", {
      id: "n_ocr",
      type: "ocr.extract",
      label: "Extract text OCR",
      params: { url: "https://example.test/receipt.png", format: "markdown", provider: "auto" },
    }),

  // Eval.
  "eval-run": () =>
    single("E2E Eval Run", {
      id: "n_eval_run",
      type: "eval.run",
      label: "Run Eval",
      params: { datasetId: "dataset_fixture", targetKind: "chat", model: "gpt-4.1" },
    }),
  "eval-gate": () =>
    single("E2E Eval Gate", {
      id: "n_eval_gate",
      type: "eval.gate",
      label: "Eval Gate",
      params: { runId: "eval_run_fixture", minPassAt1: 0.8 },
    }),

  // Desktop actions.
  "action-desktop-screenshot": () =>
    single("E2E Desktop Screenshot", {
      id: "n_ds",
      type: "action.desktop.screenshot",
      label: "Screenshot",
      params: { format: "png", region: { x: 0, y: 0, width: 640, height: 480 } },
    }),
  "action-desktop-find-element": () =>
    single("E2E Desktop Find Element", {
      id: "n_fe",
      type: "action.desktop.findElement",
      label: "Find",
      params: { locator: { automationId: "btnOk", controlType: "button" } },
    }),
  "action-desktop-read-tree": () =>
    single("E2E Desktop Read Tree", {
      id: "n_rt",
      type: "action.desktop.readTree",
      label: "Tree",
      params: { root: "window_fixture", maxDepth: 3 },
    }),
  "action-desktop-click": () =>
    single("E2E Desktop Click", {
      id: "n_dc",
      type: "action.desktop.click",
      label: "Click",
      params: { elementRef: "button_fixture", button: "left" },
    }),
  "action-desktop-type": () =>
    single("E2E Desktop Type", {
      id: "n_dt",
      type: "action.desktop.type",
      label: "Type",
      params: { target: "input_fixture", text: "hello" },
    }),
  "action-desktop-keys": () =>
    single("E2E Desktop Keys", {
      id: "n_dk",
      type: "action.desktop.keys",
      label: "Keys",
      params: { chord: "ctrl+c" },
    }),
  "action-desktop-invoke-pattern": () =>
    single("E2E Desktop Invoke Pattern", {
      id: "n_ip",
      type: "action.desktop.invokePattern",
      label: "Invoke",
      params: { target: "button_fixture", pattern: "invoke" },
    }),
  "action-desktop-window-focus": () =>
    single("E2E Desktop Window Focus", {
      id: "n_wf",
      type: "action.desktop.windowFocus",
      label: "Focus",
      params: { selector: "Notepad" },
    }),
  "action-desktop-window-close": () =>
    single("E2E Desktop Window Close", {
      id: "n_wc",
      type: "action.desktop.windowClose",
      label: "Close",
      params: { selector: "Notepad" },
    }),
  "action-desktop-window-resize": () =>
    single("E2E Desktop Window Resize", {
      id: "n_wr",
      type: "action.desktop.windowResize",
      label: "Resize",
      params: { selector: "Notepad", width: 800, height: 600 },
    }),
  "action-desktop-wait": () =>
    single("E2E Desktop Wait", {
      id: "n_dw",
      type: "action.desktop.wait",
      label: "Wait",
      params: { selector: "Toast", mode: "appear", timeoutMs: 1000 },
    }),
  "action-desktop-paste": () =>
    single("E2E Desktop Paste", {
      id: "n_dp",
      type: "action.desktop.paste",
      label: "Paste",
      params: { text: "hello" },
    }),
  "action-desktop-launch-app": () =>
    single("E2E Desktop Launch App", {
      id: "n_dla",
      type: "action.desktop.launchApp",
      label: "Launch App",
      params: { app: "notepad.exe", action: "launch" },
    }),

  // Annotations.
  "annotation-note": () => ({
    name: "E2E Annotation Note",
    nodes: [
      manualTrigger(),
      workflowNode(
        "n_note",
        "annotation.note",
        "Note",
        { text: "A reminder", color: "yellow" },
        { x: 320, y: 40 }
      ),
    ],
    edges: [],
  }),
  "annotation-group": () => ({
    name: "E2E Annotation Group",
    nodes: [
      manualTrigger(),
      workflowNode(
        "n_group",
        "annotation.group",
        "Group",
        { title: "Stage A", color: "blue", width: 320, height: 200 },
        { x: 320, y: 40 }
      ),
    ],
    edges: [],
  }),
} satisfies Record<string, WorkflowFixtureFactory>

export type SeededWorkflowKind = keyof typeof FIXTURES

export const SEEDED_WORKFLOW_KINDS = Object.keys(FIXTURES) as SeededWorkflowKind[]

/** Build the canonical fixture draft for the given seed kind. */
export function buildWorkflowFixture(kind: SeededWorkflowKind): WorkflowDraft {
  const factory = FIXTURES[kind]
  if (!factory) throw new Error(`Unknown seeded workflow kind: ${kind}`)
  return factory()
}
