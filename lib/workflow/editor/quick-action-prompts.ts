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

function buildValidatePrompt(state: EditorState): string {
  const nodesForValidator = state.nodes.map((n) => ({
    id: n.id,
    data: { kind: n.data.kind as string, params: n.data.params },
  }))
  const byStep = validateAllNodes(nodesForValidator)
  const summary = flattenSummary(byStep)
  if (summary.length === 0) {
    return [
      "/validate",
      "",
      "I just ran the local schema validator on the current workflow graph and there are **no validation errors**.",
      "",
      "Please do a quick design-level review (orphan nodes, missing error handling, redundant edges) and tell me anything you'd improve.",
    ].join("\n")
  }
  return [
    "/validate",
    "",
    `The local schema validator reports **${summary.length} issue(s)** in the current workflow graph:`,
    "",
    ...summary.map((line) => `- ${line}`),
    "",
    "Please walk through each issue, suggest a fix, and (where you're confident) use the `wf_*` MCP tools to apply the fix directly. Ask before any change that loses data.",
  ].join("\n")
}

function buildExplainPrompt(state: EditorState): string {
  const selected = state.selectedNodeIds
  const byId = new Map(state.nodes.map((n) => [n.id, n]))
  const lines: string[] = ["/explain", ""]
  if (selected.length === 0) {
    lines.push("No nodes are selected. Pick the nodes you want explained from the canvas first.")
    return lines.join("\n")
  }
  lines.push(
    `I have **${selected.length} node(s)** selected. Please explain what each does, how they connect to the rest of the graph, and any subtle behaviors I should be aware of:`,
    ""
  )
  for (const id of selected) {
    const node = byId.get(id)
    if (!node) continue
    const kind = node.data.kind as WorkflowNodeKind
    const label = node.data.label?.trim() || "(no label)"
    lines.push(`- \`${id}\` — **${label}** (kind: \`${kind}\`)`)
  }
  return lines.join("\n")
}

function buildSuggestPrompt(state: EditorState): string {
  const selected = state.selectedNodeIds
  const byId = new Map(state.nodes.map((n) => [n.id, n]))
  const anchorLines: string[] = []
  for (const id of selected) {
    const node = byId.get(id)
    if (!node) continue
    const label = node.data.label?.trim() || "(no label)"
    anchorLines.push(`- \`${id}\` — **${label}** (kind: \`${node.data.kind}\`)`)
  }
  const lines: string[] = [
    "/suggest-next",
    "",
    `Given the current workflow graph (${state.nodes.length} node(s), ${state.edges.length} edge(s))${
      selected.length > 0 ? ` and my current selection:` : ", with no selection,"
    }`,
  ]
  if (anchorLines.length > 0) {
    lines.push("", ...anchorLines)
  }
  lines.push(
    "",
    "Suggest **one** next node to add: kind, suggested label, where to wire it (which handles on which nodes), and a one-line rationale. If multiple options are reasonable, briefly mention the runner-up. Don't add the node yourself — wait for me to confirm."
  )
  return lines.join("\n")
}
