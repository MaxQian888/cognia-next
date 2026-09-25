/**
 * `pipeline.stop` — end a workflow path as a FAILED run, with a reason.
 *
 * The node catalog has no "fail the run" node, and the pipeline used to end
 * its give-up path on a `flow.set` passthrough — which completes, so a run
 * that stopped because the code would not build reported SUCCESS in the run
 * history. This node throws instead: the step fails, the run fails, and the
 * reason is the error the user reads.
 *
 * Registered through `ctx.workflow.registerNode`; the host prefixes the kind
 * to `cognia-backend-refactor.pipeline.stop`. It touches nothing, so it runs
 * in every shell.
 */

import {
  defineWorkflowNode,
  type StepExecutionContext,
  type StepExecutionResult,
} from "@cognia/plugin-sdk"

/** Unprefixed kind — the host prefixes the pluginId. */
export const PIPELINE_STOP_KIND = "pipeline.stop"

export class PipelineStoppedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "PipelineStoppedError"
  }
}

export async function executePipelineStop(
  ctx: Pick<StepExecutionContext, "params" | "log">
): Promise<StepExecutionResult> {
  const params = (ctx.params ?? {}) as { reason?: unknown }
  const reason =
    typeof params.reason === "string" && params.reason.trim()
      ? params.reason.trim()
      : "The pipeline stopped on a path that must not continue."
  ctx.log("error", reason)
  throw new PipelineStoppedError(reason)
}

export function createPipelineStopNode() {
  return defineWorkflowNode({
    kind: PIPELINE_STOP_KIND,
    typeVersion: 1,
    category: "plugin",
    label: "Stop pipeline (fail run)",
    description:
      "Fail the run with a reason. Put it at the end of a path that must not continue, so the run history shows a failure instead of a success.",
    iconName: "CircleStop",
    keywords: ["stop", "fail", "abort", "halt", "refactor"],
    retryable: false,
    paramsSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the run stopped — shown as the run's error.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    defaultParams: { reason: "" },
    execute: (ctx) => executePipelineStop(ctx),
  })
}
