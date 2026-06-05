/**
 * Zod schemas for the visual workflow definition. Used by:
 *   • `lib/db/workflows.ts` (write-time validation, optional)
 *   • `lib/workflow/runtime/orchestrator.ts` (run-time validation, required)
 *   • the editor's "Save" path so users see structured errors before persist
 *   • the JSON import dialog so a paste can be rejected with a useful message
 *
 * Per-node `params` shape is NOT validated here — each NodeRegistry entry
 * carries its own zod schema for params. This file validates only the
 * envelope (graph shape, edge integrity, settings ranges).
 */

import { z } from "zod"
import {
  WORKFLOW_NODE_KINDS,
  type VisualWorkflow,
  type WorkflowNodeKind,
} from "@/types/workflow/visual"

const workflowNodeKindSchema = z.custom<WorkflowNodeKind>(
  (val) =>
    typeof val === "string" &&
    (WORKFLOW_NODE_KINDS.includes(val as WorkflowNodeKind) ||
      // Plugin-contributed kinds: <prefix>.<...>. We accept them at the
      // envelope layer; the registry will reject if the prefix isn't known
      // when the workflow runs.
      /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(val)),
  { message: "Invalid node kind" }
)

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

// Per-node error handling (mirrors types/workflow/visual.ts
// WorkflowNodeErrorHandling). MUST stay in the schema — zod strips unknown
// keys, so omitting it here would silently drop the field before the
// orchestrator ever sees it.
const errorHandlingSchema = z.object({
  retry: z
    .object({
      maxRetries: z.number().int().min(0).max(20),
      retryIntervalMs: z.number().int().min(0),
      backoff: z.enum(["fixed", "exponential"]),
      maxIntervalMs: z.number().int().min(0).optional(),
    })
    .optional(),
  onError: z.enum(["fail", "continue", "errorBranch", "defaultValue"]).optional(),
  defaultValue: z.unknown().optional(),
})

const nodeDataSchema = z.object({
  label: z.string().min(1, "Node label is required"),
  params: z.record(z.string(), z.unknown()),
  notes: z.string().optional(),
  credentialRefs: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  errorHandling: errorHandlingSchema.optional(),
})

const nodeSchema = z.object({
  id: z.string().min(1),
  type: workflowNodeKindSchema,
  /** Container nesting (schemaVersion 2) — must reference a real node id;
   * referential integrity is enforced in `validateGraphIntegrity`. */
  parentId: z.string().min(1).optional(),
  typeVersion: z.number().int().min(1),
  position: positionSchema,
  data: nodeDataSchema,
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
})

const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
  targetHandle: z.string().optional(),
  label: z.string().optional(),
  data: z
    .object({
      // Keep in sync with WorkflowEdgeKind — "error" marks error-branch
      // edges (orchestrator's isErrorEdge also accepts sourceHandle "error").
      kind: z.enum(["default", "conditional", "parallel", "loop", "error"]).optional(),
    })
    .optional(),
})

const retryPolicySchema = z.object({
  attempts: z.number().int().min(1).max(20),
  backoff: z.enum(["exponential", "fixed"]),
  baseMs: z.number().int().min(0),
  maxMs: z.number().int().min(0).optional(),
})

const settingsSchema = z.object({
  errorPolicy: z.enum(["stop", "continue", "branch"]),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(24 * 60 * 60_000),
  concurrency: z.number().int().min(1).max(100),
  /**
   * Per ADR-0022 §3.7. Max in-flight nodes WITHIN a single run for the
   * orchestrator's ready-set scheduler. Optional; orchestrator defaults to 1.
   */
  maxConcurrency: z.number().int().min(0).max(100).optional(),
  retryDefaults: retryPolicySchema,
  timezone: z.string().optional(),
})

const credentialRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().optional(),
})

const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().positive(),
})

/**
 * Top-level workflow envelope. Note: `nodes` and `edges` integrity (edge
 * endpoints reference real node ids; cycles only allowed via loop/wait
 * nodes) is checked separately in `validateGraphIntegrity` below — zod can
 * enforce shape but not graph constraints.
 */
export const visualWorkflowSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  name: z.string().min(1, "Workflow name is required").max(120),
  description: z.string().optional(),
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  isTemplate: z.boolean().optional(),
  isBuiltIn: z.boolean().optional(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  settings: settingsSchema,
  credentials: z.record(z.string(), credentialRefSchema).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  pinData: z.record(z.string(), z.unknown()).optional(),
  staticData: z.record(z.string(), z.unknown()).optional(),
  viewport: viewportSchema.optional(),
})

export type ValidatedVisualWorkflow = z.infer<typeof visualWorkflowSchema>

/**
 * Validation result for `validateGraphIntegrity`. Any non-empty `errors[]`
 * means the workflow can't be safely run; warnings are non-fatal.
 */
export interface GraphIntegrityResult {
  errors: string[]
  warnings: string[]
}

/**
 * Checks edge endpoints, duplicate ids, dangling references, and obvious
 * cycle violations. The orchestrator runs this BEFORE topo-sort so users
 * see all problems at once instead of crashing mid-run.
 *
 * Cycles are allowed only when at least one node on the cycle is a `flow.loop`
 * or `flow.wait` — these are the explicit "back-edge" nodes. Generic cycles
 * are rejected.
 */
export function validateGraphIntegrity(wf: VisualWorkflow): GraphIntegrityResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Duplicate node ids
  const nodeIds = new Set<string>()
  for (const node of wf.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`)
    }
    nodeIds.add(node.id)
  }

  // Duplicate edge ids and dangling endpoints
  const edgeIds = new Set<string>()
  for (const edge of wf.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`Duplicate edge id: ${edge.id}`)
    }
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge ${edge.id} sources unknown node ${edge.source}`)
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge ${edge.id} targets unknown node ${edge.target}`)
    }
  }

  // Detect at least one trigger (otherwise the workflow is unrunnable).
  const triggers = wf.nodes.filter((n) => n.type.startsWith("trigger."))
  if (triggers.length === 0) {
    warnings.push("Workflow has no trigger node; manual run only.")
  }

  // Loop-body integrity (schemaVersion 2 containers).
  const nodeById = new Map(wf.nodes.map((n) => [n.id, n]))
  const isLoopContainer = (id: string | undefined): boolean => {
    if (!id) return false
    const n = nodeById.get(id)
    return !!n && n.type === "flow.loop" && n.typeVersion >= 2
  }
  for (const node of wf.nodes) {
    if (node.parentId !== undefined) {
      if (node.parentId === node.id) {
        errors.push(`Node ${node.id} cannot be its own parent`)
      } else if (!nodeById.has(node.parentId)) {
        errors.push(`Node ${node.id} has a parentId referencing missing node ${node.parentId}`)
      } else if (!isLoopContainer(node.parentId)) {
        errors.push(
          `Node ${node.id} has parentId ${node.parentId}, which is not a loop container ` +
            "(flow.loop typeVersion 2)"
        )
      }
    }
    if (
      (node.type === "flow.break" || node.type === "flow.continue") &&
      !isLoopContainer(node.parentId)
    ) {
      errors.push(`${node.type} node ${node.id} must live inside a loop body`)
    }
  }
  // Edges must not cross a container boundary — both endpoints share the same
  // parent (top level counts as a parent of `undefined`). Edges to/from the
  // container node itself are ordinary top-level edges.
  for (const edge of wf.edges) {
    const s = nodeById.get(edge.source)
    const t = nodeById.get(edge.target)
    if (!s || !t) continue
    if ((s.parentId ?? null) !== (t.parentId ?? null)) {
      errors.push(
        `Edge ${edge.id} crosses a loop container boundary (${edge.source} → ${edge.target})`
      )
    }
  }

  // Cycle detection — DFS with three colors. Cycles allowed only if any node
  // on the cycle is a flow.loop / flow.wait (explicit back-edge nodes).
  const adj = new Map<string, string[]>()
  for (const id of nodeIds) adj.set(id, [])
  for (const edge of wf.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adj.get(edge.source)!.push(edge.target)
    }
  }
  const color = new Map<string, 0 | 1 | 2>() // 0=white,1=gray,2=black
  const cycleNodes = new Set<string>()
  for (const id of nodeIds) color.set(id, 0)
  const stack: Array<{ id: string; pathIndex: number }> = []
  const path: string[] = []
  for (const start of nodeIds) {
    if (color.get(start) !== 0) continue
    stack.push({ id: start, pathIndex: 0 })
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (color.get(top.id) === 0) {
        color.set(top.id, 1)
        path.push(top.id)
      }
      const children = adj.get(top.id) ?? []
      if (top.pathIndex < children.length) {
        const child = children[top.pathIndex]
        top.pathIndex++
        const c = color.get(child)
        if (c === 0) {
          stack.push({ id: child, pathIndex: 0 })
        } else if (c === 1) {
          // Cycle found. Walk path back to `child` and collect nodes.
          const start = path.indexOf(child)
          if (start >= 0) {
            for (let i = start; i < path.length; i++) cycleNodes.add(path[i])
          }
        }
      } else {
        color.set(top.id, 2)
        path.pop()
        stack.pop()
      }
    }
  }
  if (cycleNodes.size > 0) {
    const allowed = wf.nodes.some(
      (n) => cycleNodes.has(n.id) && (n.type === "flow.loop" || n.type === "flow.wait")
    )
    if (!allowed) {
      errors.push(
        `Cycle detected through nodes: ${[...cycleNodes].join(", ")}. ` +
          "Add a flow.loop or flow.wait node to make the back-edge explicit."
      )
    }
  }

  return { errors, warnings }
}

/**
 * Convenience wrapper that runs both zod and graph integrity. Returns either
 * the validated workflow or a list of human-readable error strings.
 */
export function validateWorkflow(
  raw: unknown
):
  | { ok: true; workflow: ValidatedVisualWorkflow; warnings: string[] }
  | { ok: false; errors: string[] } {
  const parsed = visualWorkflowSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    }
  }
  const integrity = validateGraphIntegrity(parsed.data as VisualWorkflow)
  if (integrity.errors.length > 0) {
    return { ok: false, errors: integrity.errors }
  }
  return { ok: true, workflow: parsed.data, warnings: integrity.warnings }
}
