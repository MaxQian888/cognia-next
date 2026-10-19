/**
 * Prompt Center definitions for the Agent Team runtime (ADR-0236).
 *
 * The modules that send these prompts (the lead-planning deps, the task
 * dispatch node, structured dispatch, the progress ledger, the re-plan
 * checkpoint, the ultracode planner) pull in the team runtime, the workflow
 * engine and the stores. The definitions live here instead, in a leaf module,
 * so the catalog can list them without importing any of that. Each consumer
 * resolves its own definition (see `consumers`); nothing here resolves.
 *
 * Editable entries are the stable instruction wording. Text a parser reads —
 * the JSON-only instruction, the repair note, the JSON schema hints — is
 * inspect-only and rendered from its definition so the editor shows exactly
 * what is sent. Conditional fragments (a reviewer's feedback block, a
 * recruiting roster) stay in the owning builder and reach the body through a
 * placeholder.
 */

import { definePrompt, type PromptResolutionContext } from "@/lib/prompts/types"
import type { AgentTeam } from "@/types/agent/agent-team"

/** Live values are clipped to this; far above any goal, roster or result a run carries. */
const LIVE_VALUE_MAX = 200_000

/**
 * Where a team's prompts resolve: the account, plus the team's project
 * (workspace) when it has one. A team never picks up another project's
 * customization.
 */
export function teamPromptContext(team: Pick<AgentTeam, "projectId">): PromptResolutionContext {
  return team.projectId ? { workspaceId: team.projectId } : {}
}

// ── Lead planning ─────────────────────────────────────────────────────────

/**
 * The planning lead's system prompt when neither the lead nor the team
 * configures one. The plan is parsed from one fenced JSON block.
 */
export const LEAD_PLANNING_SYSTEM_PROMPT = definePrompt({
  id: "team.lead.planning-system",
  contractVersion: 1,
  kind: "role",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // The reply is parsed as a fenced JSON plan; an unparseable plan fails planning.
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 4_000,
  requiredFragments: ["```json"],
  outputContract:
    "Used as the lead's system prompt for plan generation only when the lead and the team set none; the reply is parsed as one ```json fenced plan block.",
  consumers: ["lib/ai/agent/team/agent-team-runtime-deps.ts"],
  defaultBody:
    "You are a planning lead. Always respond with a single ```json fenced block matching the requested shape. Do not add prose around the block.",
})

/** The lead's planning request: goal, roster, optional reviewer feedback, plan shape. */
export const LEAD_PLANNING_PROMPT = definePrompt({
  id: "team.lead.planning",
  contractVersion: 1,
  kind: "feature-template",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // The plan JSON is parsed into the run's steps.
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 8_000,
  variables: [
    { name: "teamName", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "teamGoal", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "workerCount", required: false, maxChars: 16 },
    { name: "roster", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "reviewerFeedback", required: true, maxChars: LIVE_VALUE_MAX },
  ],
  requiredFragments: ["```json", '"summary"', '"steps"', '"title"', '"assignTo"'],
  outputContract:
    'The reply is parsed as one ```json fenced block {"summary", "steps": [{"title", "description", "assignTo"}]}. {{roster}} is one "- name: role" line per teammate; {{reviewerFeedback}} is empty on the first pass and carries the rejected plan\'s feedback block (with its own surrounding newlines) on a revision.',
  consumers: ["lib/ai/agent/team/agent-team-runtime-deps.ts"],
  defaultBody: [
    "You are {{teamName}}'s lead.",
    "Team goal:\n{{teamGoal}}",
    "",
    "Available teammates ({{workerCount}}):",
    "{{roster}}",
    "{{reviewerFeedback}}",
    "Produce a plan inside a single ```json fenced block with this shape:",
    "```json",
    "{",
    '  "summary": "one-sentence overview",',
    '  "steps": [',
    '    { "title": "...", "description": "...", "assignTo": "<teammate name or any>" }',
    "  ]",
    "}",
    "```",
    "Keep steps to 3–6 items. Each step should be actionable and self-contained.",
  ].join("\n"),
})

// ── Teammate task dispatch ────────────────────────────────────────────────

/** The prompt a teammate receives for one assigned task. */
export const TEAMMATE_TASK_PROMPT = definePrompt({
  id: "team.teammate.task",
  contractVersion: 1,
  kind: "feature-template",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app", "cli"],
  maxChars: 8_000,
  variables: [
    { name: "teammateName", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "teamName", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "role", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "briefing", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "teamGoal", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "taskTitle", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "taskDescription", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "expectedOutput", required: false, maxChars: LIVE_VALUE_MAX },
  ],
  outputContract:
    "Sent as the teammate's task message; the reply is the task's deliverable. {{briefing}} and {{expectedOutput}} are empty or a host-rendered block that starts and ends with a newline.",
  consumers: ["lib/ai/agent/team/agent-team-runtime-deps.ts"],
  defaultBody: [
    'You are {{teammateName}}, a teammate on the "{{teamName}}" team.',
    "Your role: {{role}}.{{briefing}}",
    "",
    "Team goal:\n{{teamGoal}}",
    "",
    'Your assigned task — "{{taskTitle}}":',
    "{{taskDescription}}",
    "{{expectedOutput}}",
    "Produce the deliverable directly. Be concise, structured, and concrete.",
    "If you cannot complete the task, explain why in one short paragraph.",
  ].join("\n"),
})

/** The heading over the upstream results a dependent task builds on. */
export const TEAMMATE_UPSTREAM_RESULTS_PROMPT = definePrompt({
  id: "team.teammate.upstream-results",
  contractVersion: 1,
  kind: "feature-template",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app", "cli"],
  maxChars: 2_000,
  outputContract:
    "Placed above the upstream task results (one ### section each) that precede the teammate's task prompt; only sent when the task has dependencies with results.",
  consumers: ["lib/ai/agent/team/workflow-nodes/index.ts"],
  defaultBody: "Upstream results from teammates whose tasks you depend on — build on these:",
})

/** The message that sends a task back to its author after the lead requested changes. */
export const REVIEW_REVISION_REQUEST_PROMPT = definePrompt({
  id: "team.review.revision-request",
  contractVersion: 1,
  kind: "feature-template",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app", "cli"],
  maxChars: 4_000,
  variables: [
    { name: "taskTitle", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "feedback", required: true, maxChars: LIVE_VALUE_MAX },
  ],
  outputContract:
    "Sent to the same teammate in the same worktree; its reply is reviewed again by the lead. {{feedback}} is the lead's verdict feedback verbatim.",
  consumers: ["lib/ai/agent/team/workflow-nodes/index.ts"],
  defaultBody: [
    'Your work on "{{taskTitle}}" was reviewed and needs changes.',
    "",
    "Reviewer feedback:",
    "{{feedback}}",
    "",
    "Revise your work in the same workspace and report what you changed.",
  ].join("\n"),
})

// ── Structured dispatch (protocol) ────────────────────────────────────────

/** Appended to every structured teammate dispatch; the reply is parsed from the fence. */
export const STRUCTURED_JSON_INSTRUCTION_PROMPT = definePrompt({
  id: "team.structured.json-instruction",
  contractVersion: 1,
  kind: "protocol",
  group: "team",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app", "cli"],
  outputContract:
    "Appended (after a blank line) to every structured dispatch; the reply is parsed from one ```json fence and validated against the caller's schema.",
  consumers: ["lib/ai/agent/team/teammate/structured-dispatch.ts"],
  defaultBody:
    "When you are done, respond with ONLY a single fenced JSON code block " +
    "(```json … ```) that matches the required schema. Put no prose before or after the block.",
})

/** The repair note on a retry after an unparseable or schema-invalid reply. */
export const STRUCTURED_RETRY_NOTE_PROMPT = definePrompt({
  id: "team.structured.retry-note",
  contractVersion: 1,
  kind: "protocol",
  group: "team",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app", "cli"],
  variables: [{ name: "error", required: true, maxChars: LIVE_VALUE_MAX }],
  outputContract:
    "Appended (after a blank line) to a structured dispatch retry; {{error}} is the parse or schema error of the previous reply.",
  consumers: ["lib/ai/agent/team/teammate/structured-dispatch.ts"],
  defaultBody:
    "Your previous response was invalid: {{error}}\nReturn corrected JSON only — no other text.",
})

// ── Progress ledger ───────────────────────────────────────────────────────

/** The stall judge: diagnose a sustained stall and recommend one action. */
export const PROGRESS_LEDGER_JUDGE_PROMPT = definePrompt({
  id: "team.ledger.judge",
  contractVersion: 1,
  kind: "feature-template",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // The verdict is schema-parsed, and its action can escalate the run to a
  // consensus vote or a delegation. A dispatch failure falls back to "replan".
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 8_000,
  variables: [
    { name: "teamName", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "objective", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "stallCount", required: false, maxChars: 16 },
    { name: "results", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "remaining", required: true, maxChars: LIVE_VALUE_MAX },
  ],
  requiredFragments: ['"continue"', '"replan"', '"consensus"', '"delegate"'],
  outputContract:
    "The JSON schema hint and the JSON-only instruction are appended; the reply is validated as a progress verdict, and any failure falls back to a non-escalating replan.",
  consumers: ["lib/ai/agent/team/ledger/progress-ledger.ts"],
  defaultBody: [
    'You are the progress monitor for the agent team "{{teamName}}".',
    "Objective: {{objective}}",
    "The team has stalled for {{stallCount}} consecutive wave(s) — no new completed tasks or output.",
    "",
    "Completed-task results so far:",
    "{{results}}",
    "",
    "Remaining planned tasks:",
    "{{remaining}}",
    "",
    "Diagnose the stall and recommend exactly one action:",
    '- "continue": the stall is benign; keep the current plan.',
    '- "replan": the lead should revise the remaining tasks.',
    '- "consensus": the team disagrees; open a vote to settle direction.',
    '- "delegate": hand a blocking sub-problem to a fresh background agent.',
    "Set isSatisfied=true only if the objective is already met.",
  ].join("\n"),
})

/** Schema hint appended to the judge prompt; its keys are what the verdict schema reads. */
export const PROGRESS_LEDGER_SCHEMA_HINT_PROMPT = definePrompt({
  id: "team.ledger.schema-hint",
  contractVersion: 1,
  kind: "protocol",
  group: "team",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app", "cli"],
  outputContract: "Appended to the judge prompt as the schema of the progress verdict.",
  consumers: ["lib/ai/agent/team/ledger/progress-ledger.ts"],
  defaultBody: [
    '{ "isSatisfied": boolean,',
    '  "isProgressing": boolean,',
    '  "isLooping": boolean,',
    '  "diagnosis": string,',
    '  "recommendedAction": "continue" | "replan" | "consensus" | "delegate",',
    '  "target"?: string }',
  ].join("\n"),
})

// ── Re-plan checkpoint ────────────────────────────────────────────────────

/** The lead's between-waves re-plan request. */
export const REPLAN_LEAD_PROMPT = definePrompt({
  id: "team.replan.lead",
  contractVersion: 1,
  kind: "feature-template",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // The decision is schema-parsed and edits the remaining plan (optionally
  // behind the re-plan approval gate). A dispatch failure continues unchanged.
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 8_000,
  variables: [
    { name: "teamName", required: false, maxChars: LIVE_VALUE_MAX },
    { name: "objective", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "results", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "remaining", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "recruitRoster", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "recruitAction", required: true, maxChars: LIVE_VALUE_MAX },
  ],
  requiredFragments: ['"continue"', '"inject"', '"cancel"', '"reorder"', '"finish"'],
  outputContract:
    'The re-plan schema hint and the JSON-only instruction are appended; the reply is validated as a re-plan decision. {{recruitRoster}} and {{recruitAction}} are empty unless the run can recruit digital employees, then carry the recruitable roster block and the "recruit" action line.',
  consumers: ["lib/ai/agent/team/durable/replan-checkpoint.ts"],
  defaultBody: [
    'You are the lead of the agent team "{{teamName}}".',
    "Objective: {{objective}}",
    "",
    "Results from the wave that just completed:",
    "{{results}}",
    "",
    "Remaining planned tasks:",
    "{{remaining}}{{recruitRoster}}",
    "",
    "Decide how to proceed. Choose exactly one action:",
    '- "continue": keep the remaining plan as-is.',
    '- "inject": add new follow-up tasks (set newTasks).',
    '- "cancel": skip some remaining tasks that are now unnecessary (set cancelTaskIds).',
    '- "reorder": change the order of the remaining tasks (set reorderTaskIds to a permutation of their ids).',
    '- "finish": the objective is met; stop early.{{recruitAction}}',
    "Be conservative — prefer continue unless the results clearly justify a change.",
  ].join("\n"),
})

// ── Ultracode planner ─────────────────────────────────────────────────────

/** The ultracode lead planner: which quality patterns to compose, and how wide. */
export const ULTRACODE_PLANNER_PROMPT = definePrompt({
  id: "team.ultracode.planner",
  contractVersion: 1,
  kind: "feature-template",
  group: "team",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // The plan is schema-parsed into the stages the run synthesizes; the body
  // teaches the pattern vocabulary the schema accepts.
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 12_000,
  variables: [
    { name: "objective", required: true, maxChars: LIVE_VALUE_MAX },
    { name: "knobs", required: false, maxChars: LIVE_VALUE_MAX },
  ],
  outputContract:
    "The plan schema hint and the JSON-only instruction are appended; the reply is validated as an ultracode plan. {{knobs}} is empty or a host-rendered team-knobs sentence that starts with a blank line.",
  consumers: ["lib/ai/agent/team/ultracode/ultracode-planner.ts"],
  defaultBody: `You are the lead planner for an ultracode multi-agent run. Design the most effective composition of quality patterns for the objective.

Available patterns (compose in a sensible order; the run is a forward pipeline):
- multi-modal-sweep: parallel finders, each a DIFFERENT search angle. \`variants\` = the distinct angles.
- loop-until-dry: keep finding until rounds go dry. \`instruction\` = what to find. \`count\` = finders per round.
- adversarial-verify: N skeptics REFUTE each finding; majority-refute kills it. \`count\` = skeptics; \`variants\` = lenses (correctness/security/perf/repro) for perspective-diverse verification.
- judge-panel: produce attempts from different angles and score them. \`variants\` = angles; \`count\` = judges per attempt.
- completeness-critic: ask "what's missing?" so gaps feed forward.
- synthesize: fold survivors + winner + gaps into the final cited report. ALWAYS end with this.

Guidance: for audit / bug-hunt / research tasks, use a finder (sweep or loop) → adversarial-verify → completeness-critic → synthesize. For design / solution tasks, use judge-panel → synthesize. Keep counts proportional to task importance; do not exceed 16.

Objective:
{{objective}}{{knobs}}`,
})

/** Schema hint appended to the ultracode planner prompt. */
export const ULTRACODE_PLAN_HINT_PROMPT = definePrompt({
  id: "team.ultracode.plan-hint",
  contractVersion: 1,
  kind: "protocol",
  group: "team",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app", "cli"],
  outputContract: "Appended to the planner prompt as the schema of the ultracode plan.",
  consumers: ["lib/ai/agent/team/ultracode/ultracode-planner.ts"],
  defaultBody:
    '{ "summary": "…", "stages": [{ "pattern": "multi-modal-sweep|loop-until-dry|adversarial-verify|judge-panel|completeness-critic|synthesize", "instruction": "…", "count"?: 1-16, "variants"?: ["…"] }] }',
})
