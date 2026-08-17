/**
 * Build the A2UI approval surface for IM-triggered workflow runs.
 *
 * `buildApprovalSurface` is emitted by the `wf_run_workflow_by_name`
 * plugin tool as part of its tool result. The model attaches this
 * surface to its reply; adapters serialise it as a native interactive
 * card (Lark interactive_message, WeCom template_card) or a plain-text
 * mirror with `[Approve] / [Cancel]` markers. The buttons carry
 * `wfapp:<bindingId>` and `wfcan:<bindingId>` action ids — distinct
 * namespaces so the bus dispatcher can route to the right `kind`
 * (wf_approve vs wf_cancel) without a payload sniff.
 *
 * Live progress / final-state presentation for workflow runs is owned by
 * `lib/execution/workflow-bridge.ts` + `lib/connectors/run-presentation/`
 * (durable execution-run cards, ADR-0089/0090) — the older step-line and
 * cumulative-status builders that used to live here were retired with the
 * `workflow-progress-runner` module (2026-08-18).
 *
 * This is a PURE function over its input; the caller owns Dexie I/O +
 * `recordCallbackBinding` calls.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"

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
