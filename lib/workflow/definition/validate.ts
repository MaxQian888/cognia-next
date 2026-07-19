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
  DEFAULT_MAX_CONCURRENCY,
  WORKFLOW_NODE_KINDS,
  type VisualWorkflow,
  type WorkflowNodeKind,
} from "@/types/workflow/visual"
import { validateConnection } from "@/lib/workflow/editor/connection-validator"

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
  // Per-node circuit breaker (A4). MUST stay here — the orchestrator reads it
  // off the VALIDATED snapshot, so omitting it would strip the breaker config
  // before the step-executor ever consults it.
  circuitBreaker: z
    .object({
      threshold: z.number().int().min(1),
      cooldownMs: z.number().int().min(0),
    })
    .optional(),
})

const nodeDataSchema = z
  .object({
    label: z.string().min(1, "Node label is required"),
    params: z.record(z.string(), z.unknown()),
    notes: z.string().optional(),
    credentialRefs: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
    authoredBy: z.enum(["ai", "user"]).optional(),
    errorHandling: errorHandlingSchema.optional(),
    /** Canvas lock (editor affordance). Kept so saves don't strip it. */
    locked: z.boolean().optional(),
  })
  // Plugin nodes may persist namespaced editor/runtime metadata alongside the
  // shared fields. WorkflowNodeData deliberately has an index signature, so
  // validating the envelope must not erase those plugin-owned values.
  .catchall(z.unknown())

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
      comment: z.string().optional(),
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
  // ADR-0070 Phase 3. Must be declared or zod strips it and the engine sees an
  // ungated workflow — the schema is what the orchestrator actually reads
  // (`validated`), not the caller's object.
  riskGating: z.boolean().optional(),
  errorPolicy: z.enum(["stop", "continue", "branch"]),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(24 * 60 * 60_000),
  concurrency: z.number().int().min(1).max(100),
  /**
   * Per ADR-0022 §3.7. Max in-flight nodes WITHIN a single run for the
   * orchestrator's ready-set scheduler. Backfilled at validation to the ONE
   * shared default so legacy persisted settings blobs without the field run
   * exactly like new workflows (the orchestrator reads the VALIDATED
   * snapshot, so this default is what actually executes).
   */
  maxConcurrency: z.number().int().min(0).max(100).default(DEFAULT_MAX_CONCURRENCY),
  retryDefaults: retryPolicySchema,
  timezone: z.string().optional(),
  /**
   * Terminal-failure safety net (A1/A2). MUST stay here — the orchestrator
   * reads it off the VALIDATED snapshot to decide whether to run the catch
   * phase / append a notify event.
   */
  onFailure: z
    .object({
      runCatchNodes: z.boolean().optional(),
      notify: z.boolean().optional(),
    })
    .optional(),
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

const workflowInterfaceSchema = z.object({
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

const workflowPublicationSchema = z.object({
  at: z.number().int().min(0),
  toolName: z.string().min(1),
})

/**
 * Top-level workflow envelope. Note: `nodes` and `edges` integrity (edge
 * endpoints reference real node ids; no cycles — iteration lives inside
 * `flow.loop` v2 containers) is checked separately in
 * `validateGraphIntegrity` below — zod can enforce shape but not graph
 * constraints.
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
  complexity: z.enum(["starter", "intermediate", "advanced"]).optional(),
  folderId: z.string().min(1).optional(),
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
  interface: workflowInterfaceSchema.optional(),
  published: workflowPublicationSchema.optional(),
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

/** Machine-readable graph-integrity issue codes (for the diagnostics engine). */
export type GraphIntegrityCode =
  | "duplicateNodeId"
  | "duplicateEdgeId"
  | "danglingSource"
  | "danglingTarget"
  | "invalidConnection"
  | "missingTrigger"
  | "selfParent"
  | "missingParent"
  | "parentNotContainer"
  | "flowOutsideLoop"
  | "containerBoundary"
  | "graphCycle"

/**
 * Structured graph-integrity issue. Carries the node/edge id so the editor's
 * Problems panel can make each issue click-to-navigate — the string form
 * (`validateGraphIntegrity`) loses that. `params` holds interpolation values
 * for the i18n message under `workflows.diagnostics.*`.
 */
export interface GraphIntegrityIssue {
  severity: "error" | "warning"
  code: GraphIntegrityCode
  nodeId?: string
  edgeId?: string
  params?: Record<string, string | number>
}

/**
 * The set of nodes that form a cycle. EVERY cycle is unauthorized: the
 * orchestrator schedules the graph as a DAG and silently drops back-edges, so
 * a "loop" drawn as a top-level cycle runs each node exactly ONCE — the only
 * construct that actually iterates is the `flow.loop` typeVersion-2 CONTAINER
 * (whose body nodes carry `parentId` and never form top-level edges).
 * Historically a cycle passing through any `flow.loop`/`flow.wait` node was
 * "authorized", which validated graphs whose runtime behavior was a silent
 * single pass; that authorization is gone. Returns an empty set when there
 * are no cycles. Shared by `collectGraphIntegrityIssues` (here) and the
 * editor diagnostics engine so the two never drift.
 */
export function collectUnauthorizedCycleNodes(wf: VisualWorkflow): Set<string> {
  const nodeIds = new Set(wf.nodes.map((n) => n.id))
  const adj = new Map<string, string[]>()
  for (const id of nodeIds) adj.set(id, [])
  for (const edge of wf.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adj.get(edge.source)!.push(edge.target)
    }
  }
  // DFS with three colors (0=white, 1=gray, 2=black). A gray child closes a cycle.
  const color = new Map<string, 0 | 1 | 2>()
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
          const at = path.indexOf(child)
          if (at >= 0) {
            for (let i = at; i < path.length; i++) cycleNodes.add(path[i])
          }
        }
      } else {
        color.set(top.id, 2)
        path.pop()
        stack.pop()
      }
    }
  }
  return cycleNodes
}

/**
 * Structured graph-integrity issues — the single source of truth for both the
 * runtime string form (`validateGraphIntegrity`) and the editor diagnostics
 * engine. Order matches the legacy string output so callers that join the
 * strings see no change.
 */
export function collectGraphIntegrityIssues(wf: VisualWorkflow): GraphIntegrityIssue[] {
  const issues: GraphIntegrityIssue[] = []

  // Duplicate node ids
  const nodeIds = new Set<string>()
  for (const node of wf.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ severity: "error", code: "duplicateNodeId", nodeId: node.id })
    }
    nodeIds.add(node.id)
  }

  // Duplicate edge ids and dangling endpoints
  const edgeIds = new Set<string>()
  for (const edge of wf.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({ severity: "error", code: "duplicateEdgeId", edgeId: edge.id })
    }
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.source)) {
      issues.push({
        severity: "error",
        code: "danglingSource",
        edgeId: edge.id,
        params: { ref: edge.source },
      })
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        severity: "error",
        code: "danglingTarget",
        edgeId: edge.id,
        params: { ref: edge.target },
      })
    }
  }

  // Detect at least one trigger (otherwise the workflow is unrunnable).
  const triggers = wf.nodes.filter((n) => n.type.startsWith("trigger."))
  if (triggers.length === 0) {
    issues.push({ severity: "warning", code: "missingTrigger" })
  }

  // Loop-body integrity (schemaVersion 2 containers).
  const nodeById = new Map(wf.nodes.map((n) => [n.id, n]))

  // Connection semantics are shared with every editor authoring path. This
  // catches malformed imported/persisted graphs too, so branch/switch output
  // handles, trigger targets, annotations, self-loops, duplicates, and error
  // routing cannot bypass the canvas validator and fail later at execution.
  const connectionNodes = wf.nodes.map((node) => ({
    id: node.id,
    data: {
      kind: node.type,
      typeVersion: node.typeVersion,
      params: node.data.params,
      errorHandling: node.data.errorHandling,
    },
  }))
  wf.edges.forEach((edge, edgeIndex) => {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return
    const validation = validateConnection(
      edge,
      connectionNodes,
      wf.edges.filter((_, candidateIndex) => candidateIndex !== edgeIndex),
      { errorPolicy: wf.settings.errorPolicy }
    )
    if (!validation.valid) {
      issues.push({
        severity: "error",
        code: "invalidConnection",
        edgeId: edge.id,
        params: { reason: validation.reason },
      })
    }
  })

  const isLoopContainer = (id: string | undefined): boolean => {
    if (!id) return false
    const n = nodeById.get(id)
    return !!n && n.type === "flow.loop" && n.typeVersion >= 2
  }
  // annotation.group (typeVersion 2) is a VISUAL container — it may host
  // children too, but unlike a loop it is not an execution boundary.
  const isGroupContainer = (id: string | undefined): boolean => {
    if (!id) return false
    const n = nodeById.get(id)
    return !!n && n.type === "annotation.group" && n.typeVersion >= 2
  }
  const isContainer = (id: string | undefined): boolean =>
    isLoopContainer(id) || isGroupContainer(id)
  // Nearest LOOP-container ancestor (walking up parentId). Group nesting is
  // transparent to the loop boundary; used by the edge-boundary check below.
  const nearestLoopAncestor = (id: string): string | undefined => {
    let p = nodeById.get(id)?.parentId
    const seen = new Set<string>()
    while (p && !seen.has(p)) {
      seen.add(p)
      const pn = nodeById.get(p)
      if (!pn) break
      if (pn.type === "flow.loop" && pn.typeVersion >= 2) return p
      p = pn.parentId
    }
    return undefined
  }
  for (const node of wf.nodes) {
    if (node.parentId !== undefined) {
      if (node.parentId === node.id) {
        issues.push({ severity: "error", code: "selfParent", nodeId: node.id })
      } else if (!nodeById.has(node.parentId)) {
        issues.push({
          severity: "error",
          code: "missingParent",
          nodeId: node.id,
          params: { parentId: node.parentId },
        })
      } else if (!isContainer(node.parentId)) {
        issues.push({
          severity: "error",
          code: "parentNotContainer",
          nodeId: node.id,
          params: { parentId: node.parentId },
        })
      }
    }
    if (
      (node.type === "flow.break" || node.type === "flow.continue") &&
      !isLoopContainer(node.parentId)
    ) {
      issues.push({
        severity: "error",
        code: "flowOutsideLoop",
        nodeId: node.id,
        params: { kind: node.type },
      })
    }
  }
  // Edges must not cross a LOOP container boundary — both endpoints share the
  // same nearest loop-container ancestor (top level = `undefined`). Edges
  // to/from the loop container node itself are ordinary top-level edges.
  // annotation.group nesting is transparent here, so a grouped node may freely
  // connect to ungrouped nodes.
  for (const edge of wf.edges) {
    const s = nodeById.get(edge.source)
    const t = nodeById.get(edge.target)
    if (!s || !t) continue
    if ((nearestLoopAncestor(edge.source) ?? null) !== (nearestLoopAncestor(edge.target) ?? null)) {
      issues.push({
        severity: "error",
        code: "containerBoundary",
        edgeId: edge.id,
        params: { source: edge.source, target: edge.target },
      })
    }
  }

  // Cycle detection — one issue per node on an unauthorized cycle so each is
  // individually clickable; the string form re-collapses them into one line.
  const cycleNodes = collectUnauthorizedCycleNodes(wf)
  if (cycleNodes.size > 0) {
    const joined = [...cycleNodes].join(", ")
    for (const nodeId of cycleNodes) {
      issues.push({
        severity: "error",
        code: "graphCycle",
        nodeId,
        params: { nodes: joined },
      })
    }
  }

  return issues
}

/** Render a structured issue back to the legacy English string (verbatim). */
function stringifyIntegrityIssue(issue: GraphIntegrityIssue): string {
  const p = issue.params ?? {}
  switch (issue.code) {
    case "duplicateNodeId":
      return `Duplicate node id: ${issue.nodeId}`
    case "duplicateEdgeId":
      return `Duplicate edge id: ${issue.edgeId}`
    case "danglingSource":
      return `Edge ${issue.edgeId} sources unknown node ${p.ref}`
    case "danglingTarget":
      return `Edge ${issue.edgeId} targets unknown node ${p.ref}`
    case "invalidConnection":
      return `Edge ${issue.edgeId} is invalid: ${p.reason}`
    case "missingTrigger":
      return "Workflow has no trigger node; manual run only."
    case "selfParent":
      return `Node ${issue.nodeId} cannot be its own parent`
    case "missingParent":
      return `Node ${issue.nodeId} has a parentId referencing missing node ${p.parentId}`
    case "parentNotContainer":
      return (
        `Node ${issue.nodeId} has parentId ${p.parentId}, which is not a loop container ` +
        "(flow.loop typeVersion 2)"
      )
    case "flowOutsideLoop":
      return `${p.kind} node ${issue.nodeId} must live inside a loop body`
    case "containerBoundary":
      return `Edge ${issue.edgeId} crosses a loop container boundary (${p.source} → ${p.target})`
    case "graphCycle":
      // Re-collapsed by the caller; never reached via the per-node path.
      return (
        `Cycle detected through nodes: ${p.nodes}. Top-level back-edges never re-execute — ` +
        "move the nodes that should repeat INSIDE a flow.loop container (typeVersion 2) instead."
      )
  }
}

/**
 * Checks edge endpoints, duplicate ids, dangling references, and obvious
 * cycle violations. The orchestrator runs this BEFORE topo-sort so users
 * see all problems at once instead of crashing mid-run.
 *
 * ALL cycles are rejected: the scheduler drops back-edges, so a cyclic graph
 * would validate and then silently run every node once. Iteration is expressed
 * with the `flow.loop` typeVersion-2 container, whose body is a nested
 * sub-canvas — never a top-level back-edge.
 *
 * Derived from `collectGraphIntegrityIssues` so the runtime strings and the
 * editor's structured diagnostics never drift.
 */
export function validateGraphIntegrity(wf: VisualWorkflow): GraphIntegrityResult {
  const errors: string[] = []
  const warnings: string[] = []
  const cycleNodes: string[] = []
  for (const issue of collectGraphIntegrityIssues(wf)) {
    if (issue.code === "graphCycle") {
      if (issue.nodeId) cycleNodes.push(issue.nodeId)
      continue
    }
    const message = stringifyIntegrityIssue(issue)
    if (issue.severity === "error") errors.push(message)
    else warnings.push(message)
  }
  if (cycleNodes.length > 0) {
    errors.push(
      `Cycle detected through nodes: ${cycleNodes.join(", ")}. ` +
        "Top-level back-edges never re-execute — move the nodes that should repeat " +
        "INSIDE a flow.loop container (typeVersion 2) instead."
    )
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
