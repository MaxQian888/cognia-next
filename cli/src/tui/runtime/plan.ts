/**
 * Pure helpers for the TUI's plan mode (Shift+Tab → `plan`). Mirrors OpenCode's
 * plan flow: while in plan mode the agent researches and proposes an approach
 * without editing; when it presents that approach, the user is asked to approve
 * (switch to build) or keep refining. These helpers classify a plan-mode reply,
 * name its on-disk copy, derive a human title, and supply the approval choices —
 * all without I/O so they unit-test trivially.
 */
import type { SelectItem } from "../state/types"

/** The synthetic user turn injected after a plan is approved — tells the agent
 * the gate is lifted and it should now implement. */
export const PLAN_APPROVED_PROMPT =
  "The plan above is approved. Proceed with the implementation now, making the changes directly."

/** The synthetic user turn injected by `/plan refine` — re-enters plan mode and
 * asks the agent to revise its latest plan without making changes yet. */
export const PLAN_REFINE_PROMPT =
  "Let's refine the plan. Reconsider the approach from the plan above and propose an updated plan — research only, do not make any changes yet."

/** The default build permission mode plan-approval switches into so edits are
 * applied without a per-edit prompt (the "auto-edits" approval). */
export const PLAN_BUILD_MODE = "acceptEdits" as const

/** A plan-approval outcome: build with auto-applied edits, build but confirm
 * each edit, or keep refining the plan. Mirrors OpenCode's multi-mode exit. */
export type PlanDecision = "approve-auto" | "approve-confirm" | "keep"

/** The choices shown in the plan-approval overlay — two approve gears plus keep. */
export const PLAN_APPROVAL_CHOICES: Array<SelectItem & { id: PlanDecision }> = [
  {
    id: "approve-auto",
    label: "✓ Approve & build (auto-edits)",
    hint: "switch to acceptEdits and implement without a prompt per edit",
  },
  {
    id: "approve-confirm",
    label: "✓ Approve — confirm each edit",
    hint: "switch to default mode and confirm every change",
  },
  { id: "keep", label: "✎ Keep planning", hint: "stay in plan mode and refine" },
]

/** The permission mode an approval decision switches into, or `null` to stay in
 * plan mode ("keep planning"). Keeps the App's approval handler declarative. */
export function planDecisionMode(d: PlanDecision): "acceptEdits" | "default" | null {
  if (d === "approve-auto") return PLAN_BUILD_MODE
  if (d === "approve-confirm") return "default"
  return null
}

/**
 * The tool names that signal "my plan is ready for approval" — the structured
 * replacement for the {@link looksLikePlan} text heuristic. `ExitPlanMode` is
 * the SDK-native plan tool on the Anthropic path; `exit_plan_mode` (bare and
 * `mcp__cognia-tools__`-namespaced) is the cross-provider cognia builtin tool
 * registered for the ai-sdk path. When the model calls any of these, the turn
 * is unambiguously presenting a final plan — never a clarifying question.
 */
export const EXIT_PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ExitPlanMode",
  "exit_plan_mode",
  "mcp__cognia-tools__exit_plan_mode",
])

/** Whether a tool call is the structured plan-ready signal (see {@link EXIT_PLAN_TOOL_NAMES}). */
export function isExitPlanTool(name: string): boolean {
  return EXIT_PLAN_TOOL_NAMES.has(name)
}

/** Render a pre-structured `steps`/`plan` array payload as a markdown bullet
 * list (mirrors `titlesFromArray` in `lib/agent/plan/exit-plan-capture.ts`). */
function bulletsFromArray(list: unknown[]): string {
  const items: string[] = []
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      items.push(item.trim())
      continue
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>
      const text = o.content ?? o.title ?? o.description
      if (typeof text === "string" && text.trim()) items.push(text.trim())
    }
  }
  return items.map((t) => `- ${t}`).join("\n")
}

/**
 * The markdown plan body carried by an `ExitPlanMode` / `exit_plan_mode` tool
 * call, or `null` when none can be extracted. Accepts both shapes the SDK uses
 * (`{ plan: string }` — the common case — and a pre-structured
 * `{ steps | plan: Array<…> }`). Reimplemented locally rather than importing
 * `lib/agent/plan/exit-plan-capture.ts`, which is `"use client"` and pulls
 * Dexie/runtime deps that must not enter the CLI bundle.
 */
export function planBodyFromExitInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const o = input as Record<string, unknown>
  if (typeof o.plan === "string" && o.plan.trim()) return o.plan
  if (Array.isArray(o.steps)) {
    const body = bulletsFromArray(o.steps)
    return body || null
  }
  if (Array.isArray(o.plan)) {
    const body = bulletsFromArray(o.plan)
    return body || null
  }
  return null
}

/**
 * Whether a plan-mode reply reads like a clarifying QUESTION rather than a
 * proposed plan — the guard that stops the {@link looksLikePlan} fallback from
 * misfiring on the agent's pre-plan questions. Conservative: a trailing `?` or
 * a recognisable interrogative opener counts. A false negative just defers to
 * the existing behaviour; the structured exit-plan tool is now the primary
 * trigger regardless.
 */
export function looksLikeQuestion(raw: string): boolean {
  const text = raw.trim()
  if (!text) return false
  if (text.endsWith("?")) return true
  return /\b(which|should i|do you want|would you like|could you|can you|what (?:would|should|do)|let me know|a few questions|before i (?:start|begin|proceed)|to confirm|need(?:s)? clarif|please clarify)\b/i.test(
    text
  )
}

/**
 * Whether a plan-mode reply reads like a proposed plan (worth surfacing the
 * approval prompt + saving) rather than a short clarifying question. Heuristic,
 * since — unlike OpenCode's explicit `plan_exit` tool — our agent has no
 * structured signal: a markdown heading, two or more list/numbered steps, or a
 * substantial body all count as a plan; a one-line question does not.
 */
export function looksLikePlan(raw: string): boolean {
  const text = raw.trim()
  if (text.length < 20) return false
  // Structural signals mark a plan regardless of length; a long prose body does
  // too. A short, unstructured reply is treated as a clarifying question.
  if (/^#{1,6}\s/m.test(text)) return true
  const listItems = (text.match(/^\s*(?:[-*+]|\d+[.)])\s+/gm) ?? []).length
  if (listItems >= 2) return true
  return text.length >= 280
}

/** A short, single-line title for a plan — its first heading or first non-empty
 * line, stripped of markdown markers and truncated. */
export function planTitle(raw: string, max = 64): string {
  const lines = raw.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const text = trimmed
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .trim()
    if (!text) continue
    return text.length > max ? text.slice(0, max - 1) + "…" : text
  }
  return "Untitled plan"
}

/** Filename-safe slug for a session id (used in the plan file name). */
function safeSlug(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "session"
  )
}

/** The on-disk file name for a captured plan: `<session>-plan-<seq>.md`. The
 * monotonic `seq` keeps a session's successive plans ordered and unique. */
export function planFileName(sessionId: string, seq: number): string {
  return `${safeSlug(sessionId)}-plan-${seq}.md`
}

/** The plan id (file name without the `.md` extension) used by `/plan show`. */
export function planIdFromFile(fileName: string): string {
  return fileName.replace(/\.md$/, "")
}

/** Non-blank, trimmed lines of a plan, as a multiset (line → count). */
function lineMultiset(raw: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    m.set(t, (m.get(t) ?? 0) + 1)
  }
  return m
}

/**
 * How a revised plan differs from the previous one, as line counts: `added` =
 * lines present in `next` but not `prev`, `removed` = the reverse. A cheap
 * multiset diff (blank lines ignored, whitespace trimmed) — enough to show a
 * `+A −R` revision badge without a full LCS. Identical plans yield `{0, 0}`.
 */
export function planDiffStat(prev: string, next: string): { added: number; removed: number } {
  const a = lineMultiset(prev)
  const b = lineMultiset(next)
  let added = 0
  let removed = 0
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0))
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0))
  return { added, removed }
}

/**
 * A line-level unified diff of two plans, as `diff`-syntax text (`-`/`+`/` `
 * prefixed lines) for `/plan diff` — rendered in a ```diff block so the document
 * pager colourises it. Uses a longest-common-subsequence backtrack so unchanged
 * lines stay as context and only real edits show as ±. Identical inputs yield an
 * all-context body.
 */
export function planDiffText(prev: string, next: string): string {
  const a = prev.split("\n")
  const b = next.split("\n")
  // LCS length table over the two line arrays.
  const m = a.length
  const n = b.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  // Backtrack the table into a unified line list.
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`)
      i++
    } else {
      out.push(`+ ${b[j]}`)
      j++
    }
  }
  while (i < m) out.push(`- ${a[i++]}`)
  while (j < n) out.push(`+ ${b[j++]}`)
  return out.join("\n")
}
