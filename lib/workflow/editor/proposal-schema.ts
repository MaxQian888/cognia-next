/**
 * Single source of truth for **validating** a raw `ProposalOp` shape.
 *
 * `proposal-types.ts` declares the TypeScript `ProposalOp` union (compile-time
 * only). This module is its runtime counterpart: one zod discriminated union
 * that any producer (today the `cognia-workflow-ai` plugin's `wf_propose_batch`
 * tool; tomorrow an NL→workflow generator) parses against — instead of each
 * hand-rolling its own field checks and drifting from the type.
 *
 * The `ProposalOpSchemaParity` type alias below is a compile-time guard: if a
 * variant's required fields drift between `proposal-types.ts` and the schema,
 * it fails to type-check. `kind` is intentionally widened to `string` (not
 * `WorkflowNodeKind`) because plugin-contributed kinds extend the built-in
 * union at runtime; the catalog/registry resolve the kind when the node is
 * applied.
 */

import { z } from "zod"
import type { ProposalOp } from "./proposal-types"

const positionSchema = z.object({ x: z.number(), y: z.number() })

/**
 * `data` (add_node) / `patch` (configure_node) are `Partial<WorkflowNodeData>`.
 * Kept permissive here — the editor store validates a node's params against the
 * kind's zod schema when the proposal is applied, so re-checking shapes at
 * propose time would only duplicate that and reject in-progress drafts.
 */
const nodeDataPatchSchema = z.record(z.string(), z.unknown())

const addNodeSchema = z.object({
  type: z.literal("add_node"),
  nodeId: z.string().min(1, "is required"),
  kind: z.string().min(1, "is required"),
  position: positionSchema,
  data: nodeDataPatchSchema.optional(),
})

const removeNodeSchema = z.object({
  type: z.literal("remove_node"),
  nodeId: z.string().min(1, "is required"),
})

const connectEdgeSchema = z.object({
  type: z.literal("connect_edge"),
  edgeId: z.string().min(1, "is required"),
  source: z.string().min(1, "is required"),
  target: z.string().min(1, "is required"),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  label: z.string().optional(),
})

const disconnectEdgeSchema = z.object({
  type: z.literal("disconnect_edge"),
  edgeId: z.string().min(1, "is required"),
})

const configureNodeSchema = z.object({
  type: z.literal("configure_node"),
  nodeId: z.string().min(1, "is required"),
  patch: nodeDataPatchSchema,
})

/** Discriminated union over the `type` field — the canonical ProposalOp shape. */
export const proposalOpSchema = z.discriminatedUnion("type", [
  addNodeSchema,
  removeNodeSchema,
  connectEdgeSchema,
  disconnectEdgeSchema,
  configureNodeSchema,
])

export type ProposalOpFromSchema = z.infer<typeof proposalOpSchema>

/** The op `type` literals the schema accepts — used for friendly errors. */
export const KNOWN_PROPOSAL_OP_TYPES: ReadonlySet<string> = new Set([
  "add_node",
  "remove_node",
  "connect_edge",
  "disconnect_edge",
  "configure_node",
])

// Compile-time no-drift guard. Every value of the hand-written `ProposalOp`
// union must be accepted by the schema's inferred shape; if a variant's
// required fields change in `proposal-types.ts` without a matching schema edit,
// `ProposalOp extends ProposalOpFromSchema` becomes `false` and this fails to
// compile. (The reverse direction is intentionally looser: the schema widens
// `kind` to `string` for plugin kinds.)
type Assert<T extends true> = T
export type ProposalOpSchemaParity = Assert<ProposalOp extends ProposalOpFromSchema ? true : false>

/**
 * Parse one raw op into a typed `ProposalOp`, or return a human error string
 * (never throws) naming the offending field — so callers can surface a
 * structured `invalid-op` error to the agent. Replaces the per-producer
 * hand-written coercion that used to duplicate (and drift from) this shape.
 */
export function coerceProposalOp(raw: unknown, index: number): ProposalOp | string {
  if (!raw || typeof raw !== "object") return `op ${index}: must be an object`
  const type = (raw as { type?: unknown }).type
  if (typeof type !== "string" || !KNOWN_PROPOSAL_OP_TYPES.has(type)) {
    return `op ${index}: unknown op type "${String(type)}"`
  }
  const parsed = proposalOpSchema.safeParse(raw)
  if (parsed.success) return parsed.data as ProposalOp
  const issue = parsed.error.issues[0]
  const field =
    issue && issue.path.length > 0 ? String(issue.path[issue.path.length - 1]) : "(value)"
  return `op ${index}: ${field} ${issue?.message ?? "is invalid"}`
}
