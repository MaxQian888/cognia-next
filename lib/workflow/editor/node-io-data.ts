/**
 * Pure resolvers for the inspector's NDV (node data view) tabs.
 *
 * Given the latest run's per-step outputs and the workflow's `pinData`, compute
 * what the Input and Output tabs should show for a selected node, plus helpers
 * for the item navigator (`toItems`) and the Schema view (`flattenSchema`).
 *
 * Platform-agnostic (lives in `lib/`) so it is unit-testable without React.
 */

import type {
  NodeIoData,
  NodeIoInputEntry,
  NodeIoOutput,
  NodeIoSource,
  SchemaRow,
  SchemaRowType,
} from "@/types/workflow/visual"
import { formatPath, type PathSegment } from "./expr-ref"

/** Minimal node shape this module needs — satisfied by editor RF nodes. */
export interface IoNode {
  id: string
  data?: { label?: string }
}

/** Minimal edge shape this module needs. */
export interface IoEdge {
  source: string
  target: string
}

export interface ResolveNodeIoInput {
  nodeId: string
  nodes: ReadonlyArray<IoNode>
  edges: ReadonlyArray<IoEdge>
  /** Latest run's per-step output, keyed by node id. */
  latestOutputs: Record<string, unknown>
  /** Workflow `pinData`, keyed by node id. Pin wins over run. */
  pinData: Record<string, unknown> | undefined
}

/** Resolve one value with pin-over-run precedence. */
function pickValue(
  nodeId: string,
  latestOutputs: Record<string, unknown>,
  pinData: Record<string, unknown> | undefined
): { value: unknown; source: NodeIoSource } {
  if (pinData && Object.prototype.hasOwnProperty.call(pinData, nodeId)) {
    return { value: pinData[nodeId], source: "pin" }
  }
  if (Object.prototype.hasOwnProperty.call(latestOutputs, nodeId)) {
    return { value: latestOutputs[nodeId], source: "run" }
  }
  return { value: undefined, source: "none" }
}

/** Compute Input + Output data for a node's NDV tabs. */
export function resolveNodeIo(input: ResolveNodeIoInput): NodeIoData {
  const { nodeId, nodes, edges, latestOutputs, pinData } = input
  const labelById = new Map(nodes.map((n) => [n.id, n.data?.label ?? n.id]))

  const picked = pickValue(nodeId, latestOutputs, pinData)
  const output: NodeIoOutput = {
    value: picked.value,
    pinned: picked.source === "pin",
    source: picked.source,
  }

  // Direct upstream node ids in edge order, deduplicated.
  const seen = new Set<string>()
  const inputs: NodeIoInputEntry[] = []
  for (const edge of edges) {
    if (edge.target !== nodeId) continue
    if (seen.has(edge.source)) continue
    seen.add(edge.source)
    const up = pickValue(edge.source, latestOutputs, pinData)
    inputs.push({
      upstreamNodeId: edge.source,
      upstreamLabel: labelById.get(edge.source) ?? edge.source,
      value: up.value,
      source: up.source,
    })
  }

  return { output, inputs }
}

/**
 * Normalize a node output into a list of "items" for the navigator. Arrays page
 * element-by-element; a single object/primitive is shown as one item; absent
 * data yields no items (the panel renders an empty state instead).
 */
export function toItems(value: unknown): unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function typeOf(value: unknown): SchemaRowType {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return "array"
  const t = typeof value
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t
  // Functions / symbols shouldn't appear in JSON-shaped run data; treat as string.
  return "string"
}

export function sampleOf(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") {
    return value.length > 40 ? JSON.stringify(value.slice(0, 40)) + "…" : JSON.stringify(value)
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === "object") return `{${Object.keys(value as object).length}}`
  return String(value)
}

export interface FlattenSchemaOptions {
  /** Maximum nesting depth to descend (default 4). */
  maxDepth?: number
  /** Maximum number of rows to emit (default 200). */
  maxRows?: number
}

/**
 * Flatten a node output value into `SchemaRow`s — one per path (excluding the
 * root). Each row carries structured `segments` so the UI can build a node
 * reference via `buildNodeRef`. Bounded by depth + row caps for huge payloads.
 */
export function flattenSchema(value: unknown, options?: FlattenSchemaOptions): SchemaRow[] {
  const maxDepth = options?.maxDepth ?? 4
  const maxRows = options?.maxRows ?? 200
  const rows: SchemaRow[] = []

  const walk = (v: unknown, segs: PathSegment[], depth: number): void => {
    if (rows.length >= maxRows) return
    if (segs.length > 0) {
      rows.push({
        segments: [...segs],
        path: formatPath(segs),
        type: typeOf(v),
        sample: sampleOf(v),
      })
    }
    if (depth >= maxDepth) return
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (rows.length >= maxRows) return
        walk(v[i], [...segs, i], depth + 1)
      }
    } else if (v !== null && typeof v === "object") {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        if (rows.length >= maxRows) return
        walk((v as Record<string, unknown>)[k], [...segs, k], depth + 1)
      }
    }
  }

  walk(value, [], 0)
  return rows
}
