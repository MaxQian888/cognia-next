import {
  combineAbortSignals,
  definePluginTool,
  type PluginToolRegistration,
} from "@cognia/plugin-sdk"
import type {
  CreateDeliverableInput,
  ParallelWorkInput,
  ReviewDeliverableInput,
  UpdateDeliverableInput,
  WorkPluginContext,
} from "./runtime"
import { createWorkRuntime } from "./runtime"

const DELIVERABLE_KINDS = ["document", "report", "spreadsheet", "presentation", "site"]
const SPECIALIST_ROLES = ["researcher", "analyst", "deliverable-reviewer"]

export const WORK_TOOL_NAMES = [
  "work_create_deliverable",
  "work_update_deliverable",
  "work_review_deliverable",
  "work_parallelize",
] as const

const [
  CREATE_DELIVERABLE_TOOL,
  UPDATE_DELIVERABLE_TOOL,
  REVIEW_DELIVERABLE_TOOL,
  PARALLELIZE_TOOL,
] = WORK_TOOL_NAMES

/**
 * Per-tool budgets. A registered tool without `timeoutMs` gets 30 s; review
 * and parallel dispatch run whole subagent turns, and a spreadsheet goes
 * through cognia-office's workbook writer.
 */
export const WORK_TOOL_TIMEOUTS_MS = {
  create: 120_000,
  review: 300_000,
  parallelize: 600_000,
} as const

export function createWorkTools(
  ctx: WorkPluginContext,
  lifecycleSignal?: AbortSignal
): PluginToolRegistration[] {
  const runtime = createWorkRuntime(ctx)
  return [
    definePluginTool({
      name: CREATE_DELIVERABLE_TOOL,
      definition: {
        name: CREATE_DELIVERABLE_TOOL,
        description:
          "Create and open a finished knowledge-work artifact: document/report (Markdown), spreadsheet (a native workbook via cognia-office), presentation, or site (HTML).",
        timeoutMs: WORK_TOOL_TIMEOUTS_MS.create,
        parametersSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: DELIVERABLE_KINDS },
            title: { type: "string", minLength: 1 },
            content: { type: "string", minLength: 1 },
          },
          required: ["kind", "title", "content"],
          additionalProperties: false,
        },
      },
      execute: (args, toolCtx) =>
        runtime.createDeliverable({
          ...(args as unknown as CreateDeliverableInput),
          ...(toolCtx.sessionId ? { sessionId: toolCtx.sessionId } : {}),
          ...(toolCtx.messageId ? { messageId: toolCtx.messageId } : {}),
        }),
    }),
    definePluginTool({
      name: UPDATE_DELIVERABLE_TOOL,
      definition: {
        name: UPDATE_DELIVERABLE_TOOL,
        description:
          "Apply a complete revised title and/or content to an existing Work artifact, then open it for review.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            content: { type: "string", minLength: 1 },
          },
          required: ["artifactId"],
          anyOf: [{ required: ["title"] }, { required: ["content"] }],
          additionalProperties: false,
        },
      },
      execute: async (args) => runtime.updateDeliverable(args as unknown as UpdateDeliverableInput),
    }),
    definePluginTool({
      name: REVIEW_DELIVERABLE_TOOL,
      definition: {
        name: REVIEW_DELIVERABLE_TOOL,
        description:
          "Run an independent reviewer subagent against explicit criteria and create a linked review artifact. Very large deliverables are reviewed from their start only (the result says `truncated`).",
        timeoutMs: WORK_TOOL_TIMEOUTS_MS.review,
        parametersSchema: {
          type: "object",
          properties: {
            artifactId: { type: "string", minLength: 1 },
            criteria: {
              type: "array",
              minItems: 1,
              maxItems: 12,
              items: { type: "string", minLength: 1 },
            },
          },
          required: ["artifactId"],
          additionalProperties: false,
        },
      },
      execute: async (args, toolCtx) => {
        const combined = combineAbortSignals(toolCtx.signal, lifecycleSignal)
        try {
          return await runtime.reviewDeliverable(
            {
              ...(args as unknown as ReviewDeliverableInput),
              ...(toolCtx.sessionId ? { sessionId: toolCtx.sessionId } : {}),
              ...(toolCtx.messageId ? { messageId: toolCtx.messageId } : {}),
            },
            { signal: combined?.signal }
          )
        } finally {
          combined?.cleanup()
        }
      },
    }),
    definePluginTool({
      name: PARALLELIZE_TOOL,
      definition: {
        name: PARALLELIZE_TOOL,
        description:
          "Run 1–4 independent research, analysis, or review tasks concurrently. Do not use for simultaneous writes to one mutable source.",
        timeoutMs: WORK_TOOL_TIMEOUTS_MS.parallelize,
        parametersSchema: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: SPECIALIST_ROLES },
                  prompt: { type: "string", minLength: 1 },
                },
                required: ["role", "prompt"],
                additionalProperties: false,
              },
            },
            cwd: { type: "string", minLength: 1 },
          },
          required: ["tasks"],
          additionalProperties: false,
        },
      },
      execute: async (args, toolCtx) => {
        const combined = combineAbortSignals(toolCtx.signal, lifecycleSignal)
        try {
          return await runtime.runParallel(args as unknown as ParallelWorkInput, {
            reportProgress: toolCtx.reportProgress,
            signal: combined?.signal,
          })
        } finally {
          combined?.cleanup()
        }
      },
    }),
  ]
}
