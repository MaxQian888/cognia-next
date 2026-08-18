"use client"

/**
 * Capture the agent's own `create_plan` / `update_plan` tool calls into the
 * unified plan pipeline — `PlanSource: "agent_tool"` (ADR-0045 §3.2).
 *
 * The sidecar tools (`sidecar/builtin-tools/plan-tools.mjs`) deliberately do
 * no work: the sidecar cannot import `lib/`, so it cannot touch Dexie or the
 * plan runtime. This module is the renderer half — it reads the tool_use
 * blocks out of the SDK event stream exactly as `captureExitPlanMode` and
 * `applyPlanModeBridge` do, and performs the write through `PlanRuntime`. That
 * keeps the one-open-plan-per-session invariant, the event log, the approval
 * dock, the tracker and the unified runs list identical for an agent-authored
 * plan and a human-authored one.
 *
 * Tool-name matching folds the `mcp__cognia-tools__` namespace and accepts the
 * PascalCase spellings from ADR-0045's original prose, so the capture works on
 * every provider and survives a rename on either side.
 */

import type { SDKAssistantMessage, SDKMessage, BetaToolUseBlock } from "@cognia/agent-config-types"
import { linearAgentTurnSteps, materializeSteps } from "./steps"
import { validatePlanStepParams } from "./step-params"
import type {
  AgentPlan,
  CreatePlanInput,
  CreatePlanStepInput,
  PlanExecutionMode,
  PlanStepKind,
  PlanStepStatus,
} from "@/types/agent/plan"

const CORE_TOOL_PREFIX = "mcp__cognia-tools__"
const CREATE_NAMES = new Set(["create_plan", "CreatePlan"])
const UPDATE_NAMES = new Set(["update_plan", "UpdatePlan"])

const STEP_KINDS: readonly PlanStepKind[] = [
  "agent_turn",
  "teammate_dispatch",
  "tool_call",
  "mcp_tool_call",
  "sub_workflow",
  "approval_gate",
]
const STEP_STATUSES: readonly PlanStepStatus[] = [
  "pending",
  "ready",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "blocked",
]
const EXECUTION_MODES: readonly PlanExecutionMode[] = ["in_session", "orchestrated", "auto"]

/** One recognised plan tool call from the event stream. */
export interface PlanToolCall {
  tool: "create" | "update"
  input: Record<string, unknown>
}

function bare(name: string | undefined): string {
  if (!name) return ""
  return name.startsWith(CORE_TOOL_PREFIX) ? name.slice(CORE_TOOL_PREFIX.length) : name
}

/** Every `create_plan` / `update_plan` tool_use block in an assistant event, in order. */
export function findPlanToolCalls(evt: SDKMessage): PlanToolCall[] {
  if (!evt || evt.type !== "assistant") return []
  const message = (evt as SDKAssistantMessage).message
  if (!message?.content || !Array.isArray(message.content)) return []
  const out: PlanToolCall[] = []
  for (const block of message.content) {
    if ((block as { type?: string }).type !== "tool_use") continue
    const tu = block as BetaToolUseBlock
    const name = bare(tu.name)
    const tool = CREATE_NAMES.has(name) ? "create" : UPDATE_NAMES.has(name) ? "update" : null
    if (!tool) continue
    const input =
      tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
        ? (tu.input as Record<string, unknown>)
        : {}
    out.push({ tool, input })
  }
  return out
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Project the tool's step array onto `CreatePlanStepInput[]`.
 *
 * Titles + the implicit linear chain come from the shared
 * {@link linearAgentTurnSteps} (so clamping and default deps match every other
 * producer); an explicit `dependsOn` replaces the implicit predecessor link,
 * and `kind` / `params` are validated against the executor's contract. A step
 * whose params fail validation keeps its kind and drops the params, so the
 * dispatcher reports a precise "requires …" error instead of the capture
 * silently rewriting the model's intent.
 */
export function planStepsFromToolInput(raw: unknown): CreatePlanStepInput[] {
  if (!Array.isArray(raw)) return []
  const entries = raw
    .map((item) => {
      if (typeof item === "string") return { title: item.trim() }
      if (!item || typeof item !== "object") return null
      const o = item as Record<string, unknown>
      const title = text(o.title) || text(o.content) || text(o.name)
      if (!title) return null
      return { title, source: o }
    })
    .filter((e): e is { title: string; source?: Record<string, unknown> } => e !== null)
  if (entries.length === 0) return []

  return linearAgentTurnSteps(entries.map((e) => e.title)).map((step, i) => {
    const o = entries[i].source
    if (!o) return step
    const kind = STEP_KINDS.includes(o.kind as PlanStepKind) ? (o.kind as PlanStepKind) : step.kind
    const dependsOn = Array.isArray(o.dependsOn)
      ? o.dependsOn.filter(
          (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d < i
        )
      : undefined
    const validated = validatePlanStepParams(kind, o.params)
    const description = text(o.description)
    return {
      ...step,
      kind,
      ...(description ? { description } : {}),
      // An explicit (valid) dependency list wins; an empty one detaches the
      // step so it can start in parallel, which is a real authoring choice.
      ...(dependsOn ? { dependsOn } : {}),
      ...("params" in validated && validated.params ? { params: validated.params } : {}),
    }
  })
}

/** Build the `CreatePlanInput` for a `create_plan` call. */
export function planInputFromCreateTool(
  input: Record<string, unknown>,
  ctx: { sessionId: string; characterId?: string; config?: CreatePlanInput["config"] }
): CreatePlanInput | null {
  const title = text(input.title)
  const steps = planStepsFromToolInput(input.steps)
  if (!title || steps.length === 0) return null
  const description = text(input.description)
  const mode = input.executionMode
  return {
    sessionId: ctx.sessionId,
    ...(ctx.characterId ? { characterId: ctx.characterId } : {}),
    title: title.slice(0, 120),
    ...(description ? { description } : {}),
    source: "agent_tool",
    executionMode: EXECUTION_MODES.includes(mode as PlanExecutionMode)
      ? (mode as PlanExecutionMode)
      : "auto",
    steps,
    ...(ctx.config ? { config: ctx.config } : {}),
  }
}

/** Resolve a `stepUpdates[].step` reference (index or id) to a step id. */
export function resolveStepId(plan: AgentPlan, ref: unknown): string | null {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    const ordered = [...plan.steps].sort((a, b) => a.order - b.order)
    return ordered[ref]?.id ?? null
  }
  const id = text(ref)
  if (!id) return null
  return plan.steps.some((s) => s.id === id) ? id : null
}

/** What a capture pass actually changed (surfaced for logging / tests). */
export interface PlanToolCaptureResult {
  created?: AgentPlan
  updated?: AgentPlan
  stepUpdates: number
}

/**
 * Hook-facing entry: apply every plan tool call in one SDK event.
 *
 * `create_plan` replaces the session's open plan (the runtime's invariant), so
 * a model that re-plans mid-turn does not accumulate drafts. `update_plan`
 * targets `planId` when given, else the session's open plan; a call that
 * targets nothing is a no-op rather than an error, because a tool call is not
 * allowed to fail a user's turn.
 */
export async function applyPlanToolCalls(
  evt: SDKMessage,
  sessionId: string,
  characterId?: string
): Promise<PlanToolCaptureResult | null> {
  const calls = findPlanToolCalls(evt)
  if (calls.length === 0) return null

  const [{ getPlanRuntime }, { loadPlanConfigDefaults }] = await Promise.all([
    import("./runtime"),
    import("./plan-settings"),
  ])
  const runtime = getPlanRuntime()
  const result: PlanToolCaptureResult = { stepUpdates: 0 }

  for (const call of calls) {
    if (call.tool === "create") {
      const config = await loadPlanConfigDefaults()
      const planInput = planInputFromCreateTool(call.input, {
        sessionId,
        ...(characterId ? { characterId } : {}),
        ...(config ? { config } : {}),
      })
      if (!planInput) continue
      result.created = await runtime.createPlan(planInput)
      continue
    }

    const planId = text(call.input.planId)
    const target = planId
      ? await runtime.getPlan(planId)
      : await runtime.getOpenPlanForSession(sessionId)
    if (!target) continue

    const title = text(call.input.title)
    const description = text(call.input.description)
    const steps = planStepsFromToolInput(call.input.steps)
    if (title || description || steps.length > 0) {
      // `updatePlanDraft` takes persisted steps, so materialise here (fresh
      // ids + index→id dependency resolution). The runtime itself refuses the
      // write once the plan is executing / terminal, which is the guard that
      // stops a model from rewriting a plan out from under its own executor.
      const updated = await runtime.updatePlanDraft(target.id, {
        ...(title ? { title: title.slice(0, 120) } : {}),
        ...(description ? { description } : {}),
        ...(steps.length > 0 ? { steps: materializeSteps(steps) } : {}),
      })
      if (updated) result.updated = updated
    }

    const updates = Array.isArray(call.input.stepUpdates) ? call.input.stepUpdates : []
    for (const raw of updates) {
      if (!raw || typeof raw !== "object") continue
      const u = raw as Record<string, unknown>
      const status = u.status
      if (!STEP_STATUSES.includes(status as PlanStepStatus)) continue
      // Re-read: an earlier update in this same batch may have replaced the
      // step list, which would invalidate an index resolved from the snapshot.
      const current = (await runtime.getPlan(target.id)) ?? target
      const stepId = resolveStepId(current, u.step)
      if (!stepId) continue
      const summary = text(u.result)
      const after = await runtime.setStepStatus(
        current.id,
        stepId,
        status as PlanStepStatus,
        summary ? { result: summary } : {}
      )
      if (after) {
        result.updated = after
        result.stepUpdates += 1
      }
    }
  }

  return result
}
