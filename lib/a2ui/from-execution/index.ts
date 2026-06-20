/**
 * "Interactive page from execution" bridge — barrel + dispatcher.
 *
 * Public surface: `buildExecutionPage(source, labels)` deterministically
 * projects a workflow run or a conversation into a portable A2UI `GeneratedApp`
 * (which flows unchanged into the mini-app hub and the share pipeline);
 * `buildSourceDigest` produces the PII-gateable text the optional LLM enhancer
 * consumes; `applyEnhancement` folds an LLM summary back onto a baseline app.
 */

import { createAppMessages, type GeneratedApp } from "@/lib/a2ui/app-generator"
import type { A2UIComponent } from "@/types/a2ui/schema"

import { buildConversationPage, extractMessageText, previewText } from "./conversation"
import type { ExecutionPageEnhancement } from "./enhance"
import { buildWorkflowRunPage } from "./workflow-run"
import type { ExecutionPageLabels, ExecutionPageSource } from "./types"

export { PageAssembler, IdGen } from "./builders"
export { buildWorkflowRunPage, formatDurationMs, stringifyOutput } from "./workflow-run"
export { buildConversationPage, extractMessageText, toolNameOf, previewText } from "./conversation"
export {
  enhanceExecutionPage,
  parseEnhancementResponse,
  sanitizeDigest,
  type ExecutionPageEnhancement,
  type EnhanceExecutionPageArgs,
} from "./enhance"
export type {
  ExecutionPageSource,
  WorkflowRunPageSource,
  ConversationPageSource,
  ExecutionPageLabels,
} from "./types"

/** Project any execution source into a baseline A2UI app. */
export function buildExecutionPage(
  source: ExecutionPageSource,
  labels: ExecutionPageLabels
): GeneratedApp {
  if (source.kind === "workflow-run") return buildWorkflowRunPage(source, labels)
  return buildConversationPage(source, labels)
}

/**
 * Build a compact, plain-text digest of a source for the LLM enhancer. Embeds
 * structure (titles, step labels + statuses + timings, turn previews) but NOT
 * raw step outputs / full message bodies — keeping the payload small and the
 * PII surface low before it hits the gate in `enhanceExecutionPage`.
 */
export function buildSourceDigest(
  source: ExecutionPageSource,
  labels: ExecutionPageLabels
): string {
  if (source.kind === "workflow-run") {
    const { run, events } = source
    const lines: string[] = []
    lines.push(`${labels.status}: ${run.status}`)
    lines.push(`${labels.trigger}: ${run.triggerKind}`)
    const completed = events.filter((e) => e.type === "step_completed").length
    const failed = events.filter((e) => e.type === "step_failed").length
    lines.push(`${labels.steps}: ${completed} ${labels.succeeded}, ${failed} ${labels.failed}`)
    for (const node of run.workflowSnapshot.nodes) {
      const label = node.data.label ?? node.id
      lines.push(`- ${label} (${node.type})`)
    }
    if (run.error) lines.push(`${labels.error}: ${run.error.message}`)
    if (typeof run.output === "string") lines.push(`output: ${previewText(run.output, 400)}`)
    return lines.join("\n")
  }

  const { session, messages } = source
  const lines: string[] = []
  lines.push(`${session.title ?? labels.untitled}`)
  lines.push(`${labels.messages}: ${messages.length}`)
  for (const m of messages) {
    const text = previewText(extractMessageText(m.parts), 200)
    if (text) lines.push(`${m.role}: ${text}`)
  }
  return lines.join("\n")
}

/**
 * Return a new app with the LLM summary prepended as a guaranteed-valid Card.
 * The enhancement's own components get a distinct id prefix so they can't
 * collide with the baseline tree, and the root's children list is rewritten to
 * place the summary first. Pure — does not mutate `app`.
 */
export function applyEnhancement(
  app: GeneratedApp,
  enhancement: ExecutionPageEnhancement,
  labels: ExecutionPageLabels
): GeneratedApp {
  const extra: A2UIComponent[] = []
  const summaryChildren: string[] = []

  summaryChildren.push("aisum-summary")
  extra.push({ id: "aisum-summary", component: "Text", text: enhancement.summary, variant: "body" })

  if (enhancement.insights.length > 0) {
    summaryChildren.push("aisum-insights")
    extra.push({
      id: "aisum-insights",
      component: "List",
      items: enhancement.insights,
      ordered: false,
      dividers: false,
    })
  }

  extra.push({
    id: "aisum-card",
    component: "Card",
    title: labels.summary,
    children: summaryChildren,
  })

  const components = app.components.map((c) => {
    if (c.id !== "root") return c
    const root = c as A2UIComponent & { children?: string[] }
    return { ...root, children: ["aisum-card", ...(root.children ?? [])] }
  })
  const merged = [
    ...components.filter((c) => c.id !== "root"),
    ...extra,
    components.find((c) => c.id === "root")!,
  ]

  const name = enhancement.title?.trim() || app.name
  return {
    ...app,
    name,
    components: merged,
    messages: createAppMessages(app.id, name, merged, app.dataModel),
  }
}
