/**
 * Shared helpers for Lark skill families (ADR-0026).
 *
 * Each skill file in this directory uses these helpers to:
 *   1. Compose `execLarkCli` argv from validated args without spaghetti.
 *   2. Build the standard A2UI confirm card for HITL writes/destructives.
 *   3. Surface a uniform error envelope when lark-cli fails.
 *
 * Skill bodies stay focused on the lark-cli argv shape; the trust gate
 * lives in `dispatcher.ts`.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { BuiltInSkillContext } from "../types"
import { execLarkCli, type ExecLarkCliInput, type LarkCliResult } from "./exec-lark-cli"

/**
 * Resolve the Lark adapter a skill invocation should authenticate as.
 * Sessions bound to a Lark conversation carry the owning adapter id in
 * `ctx.imBinding` — using it keeps multi-account setups permission-correct
 * (the auth bridge would otherwise default to the FIRST enabled adapter).
 * In-app (non-IM) sessions return undefined and keep the bridge default.
 */
export function larkAdapterIdFromCtx(ctx: BuiltInSkillContext): string | undefined {
  return ctx.imBinding?.platform === "lark" ? ctx.imBinding.adapterId : undefined
}

/** Convert the camelCase Zod arg shape into kebab-case `--flag value`. */
export function argsToFlags(
  args: Record<string, unknown>,
  /** Skip these keys — e.g. internal hints, "confirmed". */
  skip: readonly string[] = []
): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (skip.includes(key)) continue
    if (value === undefined || value === null) continue
    const flag = `--${camelToKebab(key)}`
    if (typeof value === "boolean") {
      if (value) out.push(flag)
      continue
    }
    if (Array.isArray(value)) {
      // lark-cli convention: repeat the flag for each value.
      for (const v of value) {
        out.push(flag, String(v))
      }
      continue
    }
    if (typeof value === "object") {
      out.push(flag, JSON.stringify(value))
      continue
    }
    out.push(flag, String(value))
  }
  return out
}

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())
}

/**
 * Standard HITL confirm card. Two buttons (Confirm / Cancel) — the
 * dispatcher's binding looks up `Confirm`'s action by component id.
 *
 *   - `title` — short headline, e.g. "Create calendar event"
 *   - `summary` — one or two sentences describing what will change
 *   - `details` — optional key/value rows shown beneath the summary
 */
export function buildConfirmSurface(input: {
  surfaceId: string
  title: string
  summary: string
  details?: ReadonlyArray<{ label: string; value: string }>
  confirmLabel?: string
  cancelLabel?: string
}): A2UISegmentContent {
  const detailRows = (input.details ?? []).map((d, i) => ({
    component: "Text",
    props: { text: `**${d.label}**: ${d.value}` },
    id: `detail_${i}`,
  }))
  return {
    rootId: input.surfaceId,
    surfaceType: "inline",
    title: input.title,
    components: {
      [input.surfaceId]: {
        component: "Card",
        props: { title: input.title },
        children: ["summary", ...detailRows.map((r) => r.id), "actions"],
      },
      summary: {
        component: "Text",
        props: { text: input.summary },
      },
      ...Object.fromEntries(detailRows.map((r) => [r.id, r])),
      actions: {
        component: "Row",
        children: ["btn_confirm", "btn_cancel"],
      },
      btn_confirm: {
        component: "Button",
        props: {
          label: input.confirmLabel ?? "Confirm",
          variant: "primary",
          action: { type: "button", value: "confirm" },
        },
      },
      btn_cancel: {
        component: "Button",
        props: {
          label: input.cancelLabel ?? "Cancel",
          variant: "secondary",
          action: { type: "button", value: "cancel" },
        },
      },
    },
    dataModel: {},
  }
}

/**
 * Display cap on the lark-cli result handed back to the model. lark-cli
 * list/search responses (pageSize up to 500) can serialize to ~1 MB of JSON —
 * the process `maxBuffer` bounds what we READ, this bounds what the MODEL sees.
 * Mirrors the capture-vs-display split the sidecar built-in tools use.
 */
export const MAX_RESULT_DISPLAY_CHARS = 24_000

/**
 * Bound a lark-cli result for model display. Small results (the common case)
 * pass through UNCHANGED so structured consumers still get the parsed value;
 * an oversized result is replaced with a truncation envelope carrying a JSON
 * preview and a "narrow the query" hint. Pure + serialization-based so it's
 * cheap to test.
 */
export function capLarkData(data: unknown): unknown {
  if (typeof data === "string") {
    return data.length > MAX_RESULT_DISPLAY_CHARS
      ? `${data.slice(0, MAX_RESULT_DISPLAY_CHARS)}\n… (output truncated — narrow the query or lower pageSize)`
      : data
  }
  let json: string
  try {
    json = JSON.stringify(data)
  } catch {
    return data // non-serializable (cycles) — hand back untouched
  }
  if (json.length <= MAX_RESULT_DISPLAY_CHARS) return data
  return {
    truncated: true,
    note: `lark-cli returned ${json.length} chars; truncated to ${MAX_RESULT_DISPLAY_CHARS}. Narrow the query, lower pageSize, or request a specific record/id.`,
    preview: `${json.slice(0, MAX_RESULT_DISPLAY_CHARS)}…`,
  }
}

/**
 * Run lark-cli and normalise the result into the skill execute() return
 * shape. On any non-ok result, throws an Error whose message the
 * dispatcher captures in the audit row + bubbles back to the assistant
 * tool-call.
 */
export async function runLarkCli(input: ExecLarkCliInput): Promise<unknown> {
  const result = await execLarkCli(input)
  if (result.status === "ok") return capLarkData(result.data)
  throw new Error(formatExecError(result))
}

function formatExecError(result: Extract<LarkCliResult, { status: "error" }>): string {
  const tail = result.stderr ? ` — ${truncate(result.stderr, 200)}` : ""
  const code = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""
  return `lark-cli ${result.reason}${code}: ${result.message}${tail}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
