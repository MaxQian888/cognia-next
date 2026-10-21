/**
 * The plugin contract's share of `lib/workflow/publish/run-workflow-typed-tool.ts`, which re-exports these.
 */
export type RunWorkflowTypedResult =
  | {
      ok: true
      workflowId: string
      workflowName: string
      runId: string
      output: unknown
    }
  | {
      ok: false
      error: { code: string; message: string; detail?: unknown }
    }
