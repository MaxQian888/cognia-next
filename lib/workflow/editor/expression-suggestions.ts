/**
 * Build autocomplete entries for the workflow expression editor.
 *
 * Sources:
 *   • `$node['<id>'].out.<field>`  — every other node in the graph; field
 *                                    list is best-effort (from the most
 *                                    recent successful run's output, falling
 *                                    back to a generic `out.*` placeholder).
 *   • `$trigger.payload.<field>`   — the trigger payload (workflow-level).
 *   • `$trigger.kind`              — string trigger kind.
 *   • `$static.<key>`              — workflow static-data variables.
 *   • `$params.<key>`              — current node's params (resolved).
 *
 * The output is platform-agnostic — it lives in `lib/` so headless tests can
 * exercise it without booting CodeMirror.
 */

import type { WorkflowNode, WorkflowNodeKind } from "@/types/workflow/visual"

export interface SuggestionEntry {
  /** Inserted at the cursor when the user accepts the suggestion. */
  insert: string
  /** Display label in the autocomplete popup. */
  label: string
  /** Auxiliary detail line (e.g., the node kind, "trigger payload", etc.). */
  detail?: string
  /** "variable" / "method" / "field" / "keyword" — drives the icon. */
  kind?: "variable" | "field" | "keyword" | "method"
  /** Search boost — higher floats to top. */
  boost?: number
}

/**
 * Build the suggestion list for one workflow's expression context. Excludes
 * the current node (it can't reference its own output) when `currentNodeId`
 * is given.
 */
export function buildExpressionSuggestions(opts: {
  nodes: WorkflowNode[]
  currentNodeId?: string
  /** Per-node output schema hints from the latest successful run, keyed by
   * stepId. Maps to a flat list of `out.X` field names. Optional. */
  outputSchemas?: Record<string, string[]>
  /** Static-data variable names declared so far. */
  staticKeys?: string[]
  /** Trigger payload keys hinted by the trigger kind. */
  triggerHints?: { kind: string; payloadKeys: string[] }
}): SuggestionEntry[] {
  const out: SuggestionEntry[] = []

  // Top-level keywords.
  out.push(
    {
      insert: "$trigger",
      label: "$trigger",
      detail: "trigger event",
      kind: "keyword",
      boost: 90,
    },
    { insert: "$static", label: "$static", detail: "static data", kind: "keyword", boost: 80 },
    {
      insert: "$params",
      label: "$params",
      detail: "current node params",
      kind: "keyword",
      boost: 70,
    }
  )

  // Trigger payload + kind.
  out.push({
    insert: "$trigger.kind",
    label: "$trigger.kind",
    detail: "string",
    kind: "field",
    boost: 60,
  })
  if (opts.triggerHints) {
    for (const k of opts.triggerHints.payloadKeys) {
      out.push({
        insert: `$trigger.payload.${k}`,
        label: `$trigger.payload.${k}`,
        detail: opts.triggerHints.kind,
        kind: "field",
        boost: 65,
      })
    }
  }

  // Static-data variables.
  for (const k of opts.staticKeys ?? []) {
    out.push({
      insert: `$static.${k}`,
      label: `$static.${k}`,
      detail: "static data",
      kind: "variable",
      boost: 55,
    })
  }

  // Per-node outputs.
  for (const node of opts.nodes) {
    if (opts.currentNodeId && node.id === opts.currentNodeId) continue
    if (node.type.startsWith("annotation.")) continue
    const fields = opts.outputSchemas?.[node.id]
    const baseInsert = `$node['${node.id}'].out`
    out.push({
      insert: baseInsert,
      label: baseInsert,
      detail: nodeDetail(node.type, node.data?.label),
      kind: "variable",
      boost: 50,
    })
    if (fields && fields.length > 0) {
      for (const f of fields) {
        out.push({
          insert: `${baseInsert}.${f}`,
          label: `${baseInsert}.${f}`,
          detail: nodeDetail(node.type, node.data?.label),
          kind: "field",
          boost: 40,
        })
      }
    } else {
      // Generic fallback so users still get an explorable path.
      out.push({
        insert: `${baseInsert}.<field>`,
        label: `${baseInsert}.<field>`,
        detail: nodeDetail(node.type, node.data?.label),
        kind: "field",
        boost: 30,
      })
    }
  }

  return out
}

function nodeDetail(kind: WorkflowNodeKind, label?: string): string {
  return label ? `${label} (${kind})` : kind
}

/**
 * Probe a node's output object for top-level field names. Used by run-status
 * bridge consumers to populate `outputSchemas` after each successful step.
 */
export function probeOutputFields(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return []
  return Object.keys(output as Record<string, unknown>)
}
