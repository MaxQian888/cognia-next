/**
 * Build A2UI surfaces and message segments for IM-triggered workflow runs.
 *
 * Three builder shapes — each consumed in a different stage of the
 * IM-side lifecycle and routed through `enqueueOutbound`:
 *
 *   1. `buildApprovalSurface` — emitted by the `wf_run_workflow_by_name`
 *      plugin tool as part of its tool result. The model attaches this
 *      surface to its reply; adapters serialise it as a native
 *      interactive card (Lark interactive_message, WeCom template_card)
 *      or a plain-text mirror with `[Approve] / [Cancel]` markers. The
 *      buttons carry `wfapp:<bindingId>` and `wfcan:<bindingId>` action
 *      ids — distinct namespaces so the bus dispatcher can route to the
 *      right `kind` (wf_approve vs wf_cancel) without a payload sniff.
 *
 *   2. `buildProgressSegment` — emitted by `workflow-progress-runner.ts`
 *      on every `step_started` / `step_completed` / `step_failed` /
 *      `step_skipped` event. Single markdown line — avoids creating a
 *      new surface per step (which would balloon the chat history and
 *      hit the per-conversation A2UI surface cap). Adapters degrade
 *      markdown to text trivially.
 *
 *   3. `buildFinalSurface` — emitted on `run_completed` / `run_failed` /
 *      `run_cancelled`. A summary Card with terminal status, optional
 *      truncated output, and a collapsed error payload when present.
 *      Routes through the same A2UI segment path as the approval surface
 *      so adapters that can render Cards do so natively.
 *
 * All three are PURE functions over their inputs. The runner module owns
 * Dexie I/O + `recordCallbackBinding` calls; this module just shapes the
 * surface/segment payloads.
 */

import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

const OUTPUT_SUMMARY_MAX = 500
const ERROR_MESSAGE_MAX = 280

export const WF_APPROVE_PREFIX = "wfapp:"
export const WF_CANCEL_PREFIX = "wfcan:"

export interface ApprovalSurfaceInput {
  /** Stable id for the binding pair — used in both Approve + Cancel action ids. */
  bindingId: string
  workflowName: string
  /** One-line description shown beneath the title. */
  summary?: string
}

/**
 * Build the Approve/Cancel surface. The Card has a title, optional
 * description Text, and a Row with two Buttons. Adapters with native
 * Card support render the structured form; the rest fall back to
 * `generatePlainTextMirror` which emits "# title", "summary",
 * "[Approve]", "[Cancel]" — every platform can carry that.
 *
 * The `widget.fallbackText` carries a human-friendly mirror that
 * `a2ui-to-segments.ts:buildA2UISegment` will prefer over the auto-
 * generated one — it adds the "回复 1 同意 / 2 取消" hint that the
 * personal-WeChat numeric-action mapper depends on.
 */
export function buildApprovalSurface(input: ApprovalSurfaceInput): A2UISegmentContent {
  const approveActionId = WF_APPROVE_PREFIX + input.bindingId
  const cancelActionId = WF_CANCEL_PREFIX + input.bindingId
  const safeSummary = (input.summary ?? "").trim()
  const components: Record<string, unknown> = {
    root: {
      component: "Card",
      title: input.workflowName,
      children: safeSummary.length > 0 ? ["summary", "actions"] : ["actions"],
    },
    actions: {
      component: "Row",
      children: ["approve", "cancel"],
    },
    approve: {
      component: "Button",
      text: "Approve",
      action: "approve",
      value: approveActionId,
    },
    cancel: {
      component: "Button",
      text: "Cancel",
      action: "cancel",
      value: cancelActionId,
    },
  }
  if (safeSummary.length > 0) {
    components.summary = { component: "Text", text: safeSummary }
  }
  const mirrorLines = [
    `# ${input.workflowName}`,
    ...(safeSummary.length > 0 ? [safeSummary] : []),
    "[Approve] [Cancel]",
    "回复 1 同意 / 2 取消",
  ]
  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title: input.workflowName,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

/**
 * Build a single markdown line for a step-level event. Returns `null` for
 * event types that aren't step-scoped (`run_started`, `run_log`, etc.) —
 * the caller drops nulls.
 *
 * Format is deliberately compact (one line):
 *   - `▶ Step «label» 开始`
 *   - `✓ Step «label» 完成 (1.2s)`
 *   - `✗ Step «label» 失败：message`
 *   - `⊘ Step «label» 跳过`
 *
 * The label resolution is best-effort — we accept either `event.stepId`
 * alone (when the runner doesn't have the workflow snapshot handy) or a
 * preferred label passed by the caller (which has resolved
 * `workflowSnapshot.nodes[stepId].data.label`). Falling back to `stepId`
 * is fine for debug; the workflow-progress-runner always passes a label.
 */
export function buildProgressSegment(
  event: WorkflowRunEventRow,
  opts?: { label?: string; previousStepStartedAt?: number }
): MessageSegment | null {
  const stepId = event.stepId
  if (!stepId) return null
  const label = (opts?.label ?? stepId).trim() || stepId

  switch (event.type) {
    case "step_started":
      return { type: "markdown", md: `▶ Step «${label}» 开始` }
    case "step_completed": {
      const dur =
        typeof opts?.previousStepStartedAt === "number"
          ? formatDuration(event.ts - opts.previousStepStartedAt)
          : null
      return {
        type: "markdown",
        md: dur ? `✓ Step «${label}» 完成 (${dur})` : `✓ Step «${label}» 完成`,
      }
    }
    case "step_failed": {
      const errMsg = pickErrorMessage(event.payload)
      return {
        type: "markdown",
        md: errMsg ? `✗ Step «${label}» 失败：${errMsg}` : `✗ Step «${label}» 失败`,
      }
    }
    case "step_skipped":
      return { type: "markdown", md: `⊘ Step «${label}» 跳过` }
    default:
      return null
  }
}

export interface FinalSurfaceInput {
  run: WorkflowRunRow
  /** Optional pre-rendered output summary; overrides the auto extraction. */
  outputOverride?: string
}

/**
 * Build the `cognia://workflow-run/<workflowId>/<runId>` deep link that the
 * desktop / mobile shell parses in `lib/capacitor/deeplink.ts` and routes
 * to the workflow run-detail page. Both ids are encoded so a future id
 * format that contains `/` doesn't break the parser.
 */
export function buildWorkflowRunDeepLink(run: WorkflowRunRow): string {
  return `cognia://workflow-run/${encodeURIComponent(run.workflowId)}/${encodeURIComponent(run.id)}`
}

/**
 * Per-step status used by the cumulative status card. The progress-runner
 * folds `workflowRunEvents` into one of these per stepId and re-renders
 * the card on each update.
 */
export type CumulativeStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped"

export interface CumulativeStepEntry {
  stepId: string
  label: string
  status: CumulativeStepStatus
  /** Wall-clock when the step started (filled on step_started). */
  startedAt?: number
  /** Wall-clock when the step ended (filled on completed / failed / skipped). */
  endedAt?: number
  /** Error message captured from a step_failed event, when present. */
  errorMessage?: string
  /** User-visible agent narration accumulated for the active step. */
  commentary?: string
}

export interface CumulativeStatusState {
  workflowId: string
  runId: string
  workflowName: string
  /** Insertion-ordered per-step state — the render order mirrors event arrival. */
  steps: CumulativeStepEntry[]
  /**
   * Terminal status for the run when known. While the run is in flight
   * this stays `"running"`; on `run_completed` / `run_failed` /
   * `run_cancelled` the runner switches it.
   */
  status: "running" | "succeeded" | "failed" | "cancelled"
  startedAt: number
  endedAt?: number
  deepLink: string
  /**
   * Final-state-only — the run's terminal output (success) or error
   * message (failure). Truncated by the renderer.
   */
  terminalBody?: string
}

const CUMULATIVE_TERMINAL_BODY_MAX = 500

/**
 * Cap on the *declared* (not-yet-started) tail only — executed steps stay
 * unbounded, preserving this card's long-standing behavior. Without it a
 * large workflow would declare every step on the very first dispatch and
 * blow the platform's per-message block limit (Slack hard-caps 50).
 */
const PENDING_DECLARATION_MAX = 20

function statusIcon(status: CumulativeStepStatus): string {
  switch (status) {
    case "pending":
      return "◻"
    case "running":
      return "▶"
    case "succeeded":
      return "✓"
    case "failed":
      return "✗"
    case "skipped":
      return "⊘"
  }
}

function statusLine(entry: CumulativeStepEntry): string {
  const icon = statusIcon(entry.status)
  const durationStr =
    entry.startedAt && entry.endedAt
      ? ` (${formatDuration(entry.endedAt - entry.startedAt)})`
      : entry.status === "running"
        ? " (running)"
        : ""
  const tail =
    entry.status === "failed" && entry.errorMessage
      ? ` — ${truncate(entry.errorMessage, ERROR_MESSAGE_MAX)}`
      : ""
  const commentary = entry.commentary ? `\n  ↳ ${entry.commentary}` : ""
  return `${icon} ${entry.label}${durationStr}${tail}${commentary}`
}

/**
 * Drop the pending steps past `PENDING_DECLARATION_MAX`, keeping every
 * non-pending step. Order is preserved, so the surviving pending entries
 * are the ones due to run soonest and the running step is never hidden.
 */
function capPendingTail(steps: CumulativeStepEntry[]): {
  rendered: CumulativeStepEntry[]
  hiddenPending: number
} {
  const rendered: CumulativeStepEntry[] = []
  let declaredPending = 0
  let hiddenPending = 0
  for (const entry of steps) {
    if (entry.status === "pending") {
      declaredPending++
      if (declaredPending > PENDING_DECLARATION_MAX) {
        hiddenPending++
        continue
      }
    }
    rendered.push(entry)
  }
  return { rendered, hiddenPending }
}

/**
 * Render the cumulative status card. One Card whose children are a Text
 * per step plus a footer Text + the open-run-detail Link. Adapters with
 * native Card rendering (Lark interactive_message, Slack Block Kit) get
 * the structured form; everything else degrades to the mirror text
 * which is identical line-for-line.
 *
 * The same builder is called by both the "running" updates and the
 * terminal update — the only difference is `state.status` and the
 * optional `terminalBody` line.
 */
export function buildCumulativeStatusSurface(state: CumulativeStatusState): A2UISegmentContent {
  const elapsedMs = (state.endedAt ?? Date.now()) - state.startedAt
  const headerIcon =
    state.status === "succeeded"
      ? "✓"
      : state.status === "failed"
        ? "✗"
        : state.status === "cancelled"
          ? "⊘"
          : "▶"
  const headerLabel =
    state.status === "succeeded"
      ? "Succeeded"
      : state.status === "failed"
        ? "Failed"
        : state.status === "cancelled"
          ? "Cancelled"
          : "Running"
  const title = `${headerIcon} ${state.workflowName} — ${headerLabel} (${formatDuration(elapsedMs)})`

  const components: Record<string, unknown> = {
    root: { component: "Card", title, children: [] as string[] },
    openLink: {
      component: "Link",
      text: "Open run detail",
      href: state.deepLink,
    },
  }
  const { rendered, hiddenPending } = capPendingTail(state.steps)
  const overflowLine = hiddenPending > 0 ? `… and ${hiddenPending} more pending` : ""

  const childIds: string[] = []
  for (let i = 0; i < rendered.length; i++) {
    const entry = rendered[i]
    const id = `step_${i}`
    components[id] = { component: "Text", text: statusLine(entry) }
    childIds.push(id)
  }
  if (overflowLine.length > 0) {
    components.pendingOverflow = { component: "Text", text: overflowLine }
    childIds.push("pendingOverflow")
  }
  const truncatedBody =
    state.terminalBody && state.terminalBody.length > 0
      ? truncate(state.terminalBody, CUMULATIVE_TERMINAL_BODY_MAX)
      : ""
  if (truncatedBody.length > 0) {
    components.divider = { component: "Divider" }
    components.body = { component: "Text", text: truncatedBody }
    childIds.push("divider", "body")
  }
  childIds.push("openLink")
  ;(components.root as { children: string[] }).children = childIds

  const mirrorLines = [
    `# ${title}`,
    ...rendered.map(statusLine),
    ...(overflowLine.length > 0 ? [overflowLine] : []),
    ...(truncatedBody.length > 0 ? ["---", truncatedBody] : []),
    `→ ${state.deepLink}`,
  ]

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

/**
 * Build the terminal summary surface. Three variants based on
 * `run.status`: succeeded (✓), failed (✗), cancelled (⊘). The Card body
 * carries the truncated output (for success) or error detail (for
 * failure). Cancelled runs show just status + duration.
 *
 * Output extraction tries — in order — the explicit override, the run's
 * `output` field stringified, or "no output". Errors take the `message`
 * field if present; otherwise stringify.
 *
 * Mirror text follows the same layout so plain-text platforms still
 * convey the terminal state.
 */
export function buildFinalSurface(input: FinalSurfaceInput): A2UISegmentContent {
  const { run } = input
  const durationStr = formatDuration((run.completedAt ?? Date.now()) - run.startedAt)
  const statusIcon = run.status === "succeeded" ? "✓" : run.status === "failed" ? "✗" : "⊘"
  const statusText =
    run.status === "succeeded"
      ? "Succeeded"
      : run.status === "failed"
        ? "Failed"
        : run.status === "cancelled"
          ? "Cancelled"
          : run.status
  const title = `${statusIcon} ${statusText} (${durationStr})`

  const bodyText =
    run.status === "failed"
      ? truncate(run.error?.message ?? "Unknown error", ERROR_MESSAGE_MAX)
      : run.status === "succeeded"
        ? truncate(input.outputOverride ?? stringifyOutput(run.output), OUTPUT_SUMMARY_MAX)
        : ""

  const deepLink = buildWorkflowRunDeepLink(run)
  const childIds: string[] = []
  if (bodyText.length > 0) childIds.push("body")
  childIds.push("openLink")

  const components: Record<string, unknown> = {
    root: {
      component: "Card",
      title,
      children: childIds,
    },
    openLink: {
      component: "Link",
      text: "Open run detail",
      href: deepLink,
    },
  }
  if (bodyText.length > 0) {
    components.body = { component: "Text", text: bodyText }
  }

  const mirrorLines = [`# ${title}`, ...(bodyText.length > 0 ? [bodyText] : []), `→ ${deepLink}`]

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

function pickErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const msg = (payload as { message?: unknown }).message
  if (typeof msg === "string" && msg.length > 0) return truncate(msg, ERROR_MESSAGE_MAX)
  return ""
}

function stringifyOutput(output: unknown): string {
  if (output === undefined || output === null) return ""
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m${secs}s`
}
