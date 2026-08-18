"use client"

/**
 * Capture the SDK plan-mode `ExitPlanMode` tool call into a structured
 * `AgentPlan(draft, source="exit_plan_mode")` — the closure the native plan
 * mode never had (ADR-0045 §3, P3).
 *
 * `ExitPlanMode` input is shaped one of two ways across SDK flavors:
 *   • `{ plan: string }`  — a markdown plan body (the common shape).
 *   • `{ steps | plan: Array<{ content|title|description, status? }> }` — a
 *     pre-structured list (what `plan-card.tsx` already normalises).
 * `planInputFromExitPlanMode` accepts both and yields a `CreatePlanInput`
 * whose steps are linear `agent_turn`s (each depends on the previous, so an
 * approved plan executes in order). It is pure; `captureExitPlanMode` does the
 * Dexie write via the plan runtime and is the hook-facing entry, mirroring
 * `applyPlanModeBridge`.
 */

import type { SDKAssistantMessage, SDKMessage, BetaToolUseBlock } from "@cognia/agent-config-types"
import { linearAgentTurnSteps } from "./steps"
import type {
  AgentPlan,
  CreatePlanInput,
  CreatePlanStepInput,
  PlanConfig,
} from "@/types/agent/plan"

/**
 * Split a markdown plan body into ordered step titles. Recognises `-`/`*`
 * bullets and `1.`/`1)` ordered items; falls back to a single step (whole
 * text) when no list markers are present.
 */
export function parsePlanText(plan: string): string[] {
  const lines = plan.split(/\r?\n/)
  const items: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)
    if (m && m[1].trim()) {
      // Strip surrounding markdown emphasis from the captured title.
      items.push(m[1].trim().replace(/^\*\*(.*)\*\*$/, "$1"))
    }
  }
  if (items.length > 0) return items
  // No list markers — use the first non-empty line as a single step title.
  const firstLine = lines.map((l) => l.trim()).find((l) => l.length > 0)
  return firstLine ? [firstLine.replace(/^#+\s*/, "")] : []
}

/** Extract step titles from a pre-structured `steps`/`plan` array payload. */
function titlesFromArray(list: unknown[]): string[] {
  const out: string[] = []
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim())
      continue
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>
      const text = o.content ?? o.title ?? o.description
      if (typeof text === "string" && text.trim()) out.push(text.trim())
    }
  }
  return out
}

export interface ExitPlanCaptureContext {
  sessionId: string
  characterId?: string
  /** Override the derived plan title. */
  title?: string
  /** Plan-config overrides (e.g. `AppSettings.planSettings`). Pure passthrough. */
  config?: Partial<PlanConfig>
}

/**
 * Pure: convert an `ExitPlanMode` tool input into a `CreatePlanInput`, or
 * `null` when no usable steps can be extracted.
 */
export function planInputFromExitPlanMode(
  input: unknown,
  ctx: ExitPlanCaptureContext
): CreatePlanInput | null {
  if (!input || typeof input !== "object") return null
  const o = input as Record<string, unknown>

  let titles: string[] = []
  let planText: string | undefined
  if (typeof o.plan === "string") {
    titles = parsePlanText(o.plan)
    planText = o.plan
  } else if (Array.isArray(o.steps)) {
    titles = titlesFromArray(o.steps)
  } else if (Array.isArray(o.plan)) {
    titles = titlesFromArray(o.plan)
  }

  if (titles.length === 0) return null

  const steps: CreatePlanStepInput[] = linearAgentTurnSteps(titles)

  return {
    sessionId: ctx.sessionId,
    ...(ctx.characterId ? { characterId: ctx.characterId } : {}),
    title: ctx.title ?? (titles[0] ?? "Captured plan").slice(0, 120),
    source: "exit_plan_mode",
    executionMode: "auto",
    steps,
    ...(ctx.config ? { config: ctx.config } : {}),
    // Keep the full markdown body for audit / display — the step list is a
    // lossy projection of it.
    ...(planText ? { metadata: { planText } } : {}),
  }
}

// The plan-mode signal tool across SDK flavors: the native Anthropic
// `ExitPlanMode`, and the cognia builtin `exit_plan_mode` the ai-sdk path uses
// (flat, or namespaced `mcp__cognia-tools__exit_plan_mode` under the Anthropic
// escape hatch). Fold the namespace prefix off before matching, mirroring the
// renderer's `normalizeToolName`, so capture — and thus the approval dock —
// works on every provider, not just Anthropic.
const CORE_TOOL_PREFIX = "mcp__cognia-tools__"
const EXIT_PLAN_TOOL_NAMES = new Set(["ExitPlanMode", "exit_plan_mode"])

function isExitPlanToolName(name: string | undefined): boolean {
  if (!name) return false
  const bare = name.startsWith(CORE_TOOL_PREFIX) ? name.slice(CORE_TOOL_PREFIX.length) : name
  return EXIT_PLAN_TOOL_NAMES.has(bare)
}

/** Find the first exit-plan tool_use block's input in an assistant event. */
export function findExitPlanModeInput(evt: SDKMessage): unknown | null {
  if (!evt || evt.type !== "assistant") return null
  const message = (evt as SDKAssistantMessage).message
  if (!message?.content || !Array.isArray(message.content)) return null
  for (const block of message.content) {
    if ((block as { type?: string }).type !== "tool_use") continue
    const tu = block as BetaToolUseBlock
    if (isExitPlanToolName(tu.name)) return tu.input
  }
  return null
}

/**
 * Hook-facing entry (mirrors `applyPlanModeBridge`). Scans an SDK event for an
 * `ExitPlanMode` tool call and, when present, creates a draft `AgentPlan` for
 * the session via the plan runtime. Returns the created plan or `null` when
 * there was no ExitPlanMode block or no usable steps. The plan runtime's
 * one-open-plan-per-session invariant means a re-emitted ExitPlanMode replaces
 * the prior draft rather than accumulating duplicates.
 */
export async function captureExitPlanMode(
  evt: SDKMessage,
  sessionId: string,
  characterId?: string
): Promise<AgentPlan | null> {
  const input = findExitPlanModeInput(evt)
  if (input == null) return null
  // User-level plan defaults (Settings → Agent runtime → Plan mode), shared
  // with every other plan producer. Best effort: capture must not fail because
  // settings are unreadable.
  const { loadPlanConfigDefaults } = await import("./plan-settings")
  const config = await loadPlanConfigDefaults()
  const planInput = planInputFromExitPlanMode(input, {
    sessionId,
    ...(characterId ? { characterId } : {}),
    ...(config ? { config } : {}),
  })
  if (!planInput) return null
  const { getPlanRuntime } = await import("./runtime")
  return getPlanRuntime().createPlan(planInput)
}
