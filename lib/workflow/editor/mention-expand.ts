/**
 * Workflow @-mention expansion.
 *
 * Inside the workflow-editor chat tab the user can reference graph
 * elements by typing `@node:<id>` or `@edge:<id>`. Before the message
 * reaches the agent, we expand each mention into a self-contained
 * citation so the agent sees enough context without having to call
 * `wf_read_node` for every reference.
 *
 *   `@node:n_extract` → `` `n_extract` (`ai.extract` · "Parse issue") ``
 *   `@edge:e_open_pr`  → `` `e_open_pr` (`n_extract`→`n_open_pr`) ``
 *
 * Unknown ids pass through untouched so the agent can flag the dangling
 * reference back to the user. The function is pure / synchronous and
 * accepts a minimal snapshot of nodes + edges — the editor store reads
 * are done by the caller (chat-tab) so this module stays test-friendly.
 */

export interface WorkflowMentionNode {
  id: string
  kind: string
  label?: string
}

export interface WorkflowMentionEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  label?: string
}

export interface WorkflowMentionSnapshot {
  nodes: ReadonlyArray<WorkflowMentionNode>
  edges: ReadonlyArray<WorkflowMentionEdge>
}

/**
 * The set of characters allowed inside an id token. Tightly limited to
 * what the editor store produces (`n_<nanoid>`, `e_<nanoid>`, plus the
 * `_` separator) plus dots so plugin-prefixed ids can be referenced
 * without escaping.
 */
const ID_CHARS = /[A-Za-z0-9_.-]/

/**
 * Replace every `@node:<id>` and `@edge:<id>` occurrence in `text` with
 * the canonical citation form. Mentions whose id doesn't resolve in the
 * snapshot are left verbatim so the agent surfaces them as dangling.
 */
export function expandWorkflowMentions(text: string, snapshot: WorkflowMentionSnapshot): string {
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))
  const edgeById = new Map(snapshot.edges.map((e) => [e.id, e]))

  // Pattern: a literal `@node:` or `@edge:` followed by an id token. The
  // id consists of one or more alphanumeric / `_` / `-` segments joined
  // by dots — this matches both plain ids (`n_extract`) and plugin-
  // prefixed ids (`myplugin.action.foo`) while refusing to absorb a
  // trailing period (so "@node:n_a." leaves the period as prose).
  return text.replace(
    /@(node|edge):([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g,
    (full, prefix: string, rawId: string) => {
      if (!ID_CHARS.test(rawId.slice(-1))) {
        return full
      }
      if (prefix === "node") {
        const node = nodeById.get(rawId)
        if (!node) return full
        const label = (node.label ?? "").trim()
        return label.length > 0
          ? `\`${node.id}\` (\`${node.kind}\` · "${label}")`
          : `\`${node.id}\` (\`${node.kind}\`)`
      }
      if (prefix === "edge") {
        const edge = edgeById.get(rawId)
        if (!edge) return full
        const handle = edge.targetHandle ?? edge.sourceHandle
        const handleSuffix = handle ? ` via \`${handle}\`` : ""
        const labelSuffix = edge.label ? ` "${edge.label}"` : ""
        return `\`${edge.id}\` (\`${edge.source}\`→\`${edge.target}\`${handleSuffix})${labelSuffix}`
      }
      return full
    }
  )
}

/**
 * Build a `WorkflowMentionSnapshot` from the editor store's nodes / edges
 * shape. Adapter for chat-tab callers — the editor store wraps nodes in
 * React Flow shapes (`type: "workflowNode"`, kind stored under
 * `data.kind`).
 */
export function snapshotFromEditorState(state: {
  nodes: ReadonlyArray<{
    id: string
    data: { kind?: unknown; label?: unknown }
  }>
  edges: ReadonlyArray<{
    id: string
    source: string
    target: string
    sourceHandle?: string | null
    targetHandle?: string | null
    data?: { label?: unknown } | unknown
    label?: unknown
  }>
}): WorkflowMentionSnapshot {
  const nodes: WorkflowMentionNode[] = state.nodes.map((n) => ({
    id: n.id,
    kind: typeof n.data.kind === "string" ? n.data.kind : "unknown",
    label: typeof n.data.label === "string" ? n.data.label : undefined,
  }))
  const edges: WorkflowMentionEdge[] = state.edges.map((e) => {
    const dataLabel =
      e.data && typeof e.data === "object" && "label" in e.data
        ? (e.data as { label?: unknown }).label
        : undefined
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      label:
        typeof e.label === "string"
          ? e.label
          : typeof dataLabel === "string"
            ? dataLabel
            : undefined,
    }
  })
  return { nodes, edges }
}
