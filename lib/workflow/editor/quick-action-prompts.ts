/**
 * Build the user-prompt text dispatched by the workflow chat's quick-action
 * buttons (Validate / Explain / Suggest). Extracted from `chat-tab.tsx` so
 * unit tests can exercise the pure builders without dragging the chat
 * dependency graph through the Jest transform pipeline.
 *
 * Each builder runs against a snapshot of the editor state (read at click
 * time inside the tab) and returns the markdown prompt the agent receives
 * as a user message. The agent then uses the `wf_*` MCP tools to act on
 * the request — the prompts are designed to nudge the workflow subagents
 * (designer / debugger / refactorer) rather than the generic chat agent.
 */

import { validateAllNodes, flattenSummary } from "@/lib/workflow/nodes/validate-params"
import type { WorkflowQuickActionKind } from "@/lib/workflow/editor/workflow-editor-context"
import type { EditorState } from "@/lib/workflow/editor/store"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { resolvePrompt } from "@/lib/prompts/resolve"
import { definePrompt, type PromptDefinitionV1 } from "@/lib/prompts/types"

/** Node lists and validator output are the open graph's; this only guards. */
const SUGGEST_REQUEST =
  "Suggest **one** next node to add: kind, suggested label, where to wire it (which handles on which nodes), and a one-line rationale. If multiple options are reasonable, briefly mention the runner-up. Don't add the node yourself — wait for me to confirm."

const GRAPH_VALUE_MAX = 1_000_000

function quickActionPrompt(input: {
  slug: string
  variables?: readonly string[]
  outputContract: string
  defaultBody: string
}): PromptDefinitionV1 {
  return definePrompt({
    id: `developer.workflow.quick-action.${input.slug}`,
    contractVersion: 1,
    // Sent as the user's own message in the editor's Copilot chat.
    kind: "composer-template",
    group: "developer",
    operation: "replace-template",
    scopes: ["account"],
    activation: "next-operation",
    risk: "ordinary",
    hosts: ["app"],
    maxChars: 8_000,
    variables: (input.variables ?? []).map((name) => ({
      name,
      required: true,
      maxChars: GRAPH_VALUE_MAX,
    })),
    outputContract: input.outputContract,
    consumers: ["lib/workflow/editor/quick-action-prompts.ts"],
    defaultBody: input.defaultBody,
  })
}

/**
 * The quick-action messages (ADR-0236). Each node list renders one
 * `` - `id` — **label** (kind: `kind`) `` line per node, joined so that an
 * empty list leaves the surrounding blank lines exactly as before.
 */
export const WORKFLOW_QUICK_ACTION_PROMPTS = {
  selectionReference: quickActionPrompt({
    slug: "selection-reference",
    variables: ["count", "nodes"],
    outputContract:
      "Sent as a Copilot turn that scopes the conversation to the canvas selection; {{nodes}} is one line per selected node, each ending in a line break.",
    defaultBody: [
      "I have **{{count}} node(s)** selected on the canvas and want to work on just those:",
      "",
      "{{nodes}}",
      "Read them, tell me in one or two sentences what this part of the graph does, then ask me what I want changed.",
      "Scope every proposal that follows to these nodes and their edges unless I say otherwise.",
    ].join("\n"),
  }),
  validateClean: quickActionPrompt({
    slug: "validate-clean",
    outputContract:
      "Sent as the /validate turn when the local schema validator found nothing; the Copilot's /validate rules apply to it.",
    defaultBody: [
      "/validate",
      "",
      "I just ran the local schema validator on the current workflow graph and there are **no validation errors**.",
      "",
      "Please do a quick design-level review (orphan nodes, missing error handling, redundant edges) and tell me anything you'd improve.",
    ].join("\n"),
  }),
  validateIssues: quickActionPrompt({
    slug: "validate-issues",
    variables: ["issueCount", "issues"],
    outputContract:
      'Sent as the /validate turn with the validator\'s findings; {{issues}} is one "- " line per issue.',
    defaultBody: [
      "/validate",
      "",
      "The local schema validator reports **{{issueCount}} issue(s)** in the current workflow graph:",
      "",
      "{{issues}}",
      "",
      "Please walk through each issue, suggest a fix, and (where you're confident) use the `wf_*` MCP tools to apply the fix directly. Ask before any change that loses data.",
    ].join("\n"),
  }),
  explainEmpty: quickActionPrompt({
    slug: "explain-empty",
    outputContract: "Sent as the /explain turn when nothing is selected.",
    defaultBody: [
      "/explain",
      "",
      "No nodes are selected. Pick the nodes you want explained from the canvas first.",
    ].join("\n"),
  }),
  explain: quickActionPrompt({
    slug: "explain",
    variables: ["count", "nodes"],
    outputContract:
      "Sent as the /explain turn for the selection; {{nodes}} is one line per selected node, each starting with a line break.",
    defaultBody: [
      "/explain",
      "",
      "I have **{{count}} node(s)** selected. Please explain what each does, how they connect to the rest of the graph, and any subtle behaviors I should be aware of:",
      "{{nodes}}",
    ].join("\n"),
  }),
  suggest: quickActionPrompt({
    slug: "suggest",
    variables: ["nodeCount", "edgeCount", "anchors"],
    outputContract:
      "Sent as the /suggest-next turn when nodes are selected; {{anchors}} is the selected nodes after a blank line, one per line, or empty.",
    defaultBody: [
      "/suggest-next",
      "",
      "Given the current workflow graph ({{nodeCount}} node(s), {{edgeCount}} edge(s)) and my current selection:{{anchors}}",
      "",
      SUGGEST_REQUEST,
    ].join("\n"),
  }),
  suggestUnselected: quickActionPrompt({
    slug: "suggest-unselected",
    variables: ["nodeCount", "edgeCount"],
    outputContract: "Sent as the /suggest-next turn when nothing is selected.",
    defaultBody: [
      "/suggest-next",
      "",
      "Given the current workflow graph ({{nodeCount}} node(s), {{edgeCount}} edge(s)), with no selection,",
      "",
      SUGGEST_REQUEST,
    ].join("\n"),
  }),
} as const

function render(def: PromptDefinitionV1, values?: Record<string, string>): string {
  return resolvePrompt(def, values ? { values } : {}).text
}

function nodeLine(id: string, label: string, kind: string): string {
  return `- \`${id}\` — **${label}** (kind: \`${kind}\`)`
}

export function buildQuickActionPrompt(
  kind: WorkflowQuickActionKind,
  state: EditorState
): string | null {
  if (kind === "validate") {
    return buildValidatePrompt(state)
  }
  if (kind === "explain") {
    return buildExplainPrompt(state)
  }
  if (kind === "suggest") {
    return buildSuggestPrompt(state)
  }
  return null
}

/**
 * Open the conversation scoped to the current canvas selection.
 *
 * Coze calls this "Reference": pick nodes, and what you ask next applies to
 * that subgraph rather than the whole canvas. Without it every request is
 * whole-graph, so changing three nodes in a fifty-node workflow starts with
 * describing which three.
 *
 * It is a complete turn rather than a composer prefill on purpose: the panel's
 * composer has no draft seam, and establishing the scope in the transcript is
 * what makes it hold for the follow-up turns too. Returns null when nothing is
 * selected, so the caller can fall back to just opening the panel.
 */
export function buildSelectionReferencePrompt(state: EditorState): string | null {
  const selected = state.selectedNodeIds
  if (selected.length === 0) return null
  const byId = new Map(state.nodes.map((n) => [n.id, n]))
  let nodes = ""
  for (const id of selected) {
    const node = byId.get(id)
    if (!node) continue
    const label = node.data.label?.trim() || "(no label)"
    nodes += `${nodeLine(id, label, node.data.kind)}\n`
  }
  return render(WORKFLOW_QUICK_ACTION_PROMPTS.selectionReference, {
    count: String(selected.length),
    nodes,
  })
}

function buildValidatePrompt(state: EditorState): string {
  const nodesForValidator = state.nodes.map((n) => ({
    id: n.id,
    data: { kind: n.data.kind as string, typeVersion: n.data.typeVersion, params: n.data.params },
  }))
  const byStep = validateAllNodes(nodesForValidator)
  const summary = flattenSummary(byStep)
  if (summary.length === 0) {
    return render(WORKFLOW_QUICK_ACTION_PROMPTS.validateClean)
  }
  return render(WORKFLOW_QUICK_ACTION_PROMPTS.validateIssues, {
    issueCount: String(summary.length),
    issues: summary.map((line) => `- ${line}`).join("\n"),
  })
}

function buildExplainPrompt(state: EditorState): string {
  const selected = state.selectedNodeIds
  const byId = new Map(state.nodes.map((n) => [n.id, n]))
  if (selected.length === 0) {
    return render(WORKFLOW_QUICK_ACTION_PROMPTS.explainEmpty)
  }
  let nodes = ""
  for (const id of selected) {
    const node = byId.get(id)
    if (!node) continue
    const kind = node.data.kind as WorkflowNodeKind
    const label = node.data.label?.trim() || "(no label)"
    nodes += `\n${nodeLine(id, label, kind)}`
  }
  return render(WORKFLOW_QUICK_ACTION_PROMPTS.explain, {
    count: String(selected.length),
    nodes,
  })
}

function buildSuggestPrompt(state: EditorState): string {
  const selected = state.selectedNodeIds
  const byId = new Map(state.nodes.map((n) => [n.id, n]))
  const anchorLines: string[] = []
  for (const id of selected) {
    const node = byId.get(id)
    if (!node) continue
    const label = node.data.label?.trim() || "(no label)"
    anchorLines.push(nodeLine(id, label, node.data.kind))
  }
  const counts = { nodeCount: String(state.nodes.length), edgeCount: String(state.edges.length) }
  if (selected.length === 0) {
    return render(WORKFLOW_QUICK_ACTION_PROMPTS.suggestUnselected, counts)
  }
  return render(WORKFLOW_QUICK_ACTION_PROMPTS.suggest, {
    ...counts,
    anchors: anchorLines.length > 0 ? `\n\n${anchorLines.join("\n")}` : "",
  })
}
