/**
 * Per-kind params typing, derived from the single source of truth in
 * `./params-schemas` (`PARAMS_SCHEMAS`). Lets executors and the inspector
 * narrow a node's `data.params` by its `type` discriminant instead of casting
 * through `Record<string, unknown>` at every call site.
 *
 * Type-only module: `ParamsSchemas` is brought in with `import type`, so
 * nothing here pulls zod — or the schema runtime values — into a bundle. The
 * discriminated `TypedWorkflowNode` is the type-safe counterpart of the
 * runtime-generic `WorkflowNode<TParams>` declared in `types/workflow/visual`.
 *
 * Because `PARAMS_SCHEMAS` is `satisfies Record<WorkflowNodeKind, …>`, adding a
 * node kind to the union forces a schema entry (compile error otherwise), which
 * in turn gives that kind a real params type here for free — no second list to
 * maintain.
 */

import type { z } from "zod"
import type {
  StepExecutionContext,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowNodeKind,
} from "@/types/workflow/visual"
import type { ParamsSchemas } from "./params-schemas"

/**
 * The inferred params shape for a single node kind. Falls back to `never` for
 * the (impossible) case where a mapped entry isn't a zod schema, which keeps
 * the conditional total without widening to `unknown`.
 */
export type WorkflowNodeParamsFor<K extends WorkflowNodeKind> = ParamsSchemas[K] extends z.ZodType
  ? z.infer<ParamsSchemas[K]>
  : never

/** `WorkflowNodeData` with `params` narrowed to a single kind's inferred shape. */
export type TypedWorkflowNodeData<K extends WorkflowNodeKind> = WorkflowNodeData<
  WorkflowNodeParamsFor<K>
>

/**
 * Discriminated union of every node kind, keyed by the `type` field. Narrowing
 * on `node.type` narrows `node.data.params` to that kind's inferred shape — the
 * type-safe replacement for `WorkflowNode` whose generic defaults to
 * `Record<string, unknown>`.
 */
export type TypedWorkflowNode = {
  [K in WorkflowNodeKind]: Omit<WorkflowNode<WorkflowNodeParamsFor<K>>, "type"> & { type: K }
}[WorkflowNodeKind]

/** `StepExecutionContext` with `params` narrowed to a single kind. */
export type TypedStepExecutionContext<K extends WorkflowNodeKind> = StepExecutionContext<
  WorkflowNodeParamsFor<K>
>
