import type { PluginTool, PluginToolContext } from "@/types/plugin"
import type { SreTimelineDraft } from "./evidence"
import type { SrePluginContext } from "./runtime"
import { createSreRuntime } from "./runtime"

export const SRE_TOOL_NAMES = [
  "sre_query_logs",
  "sre_query_trace",
  "sre_query_metrics",
  "sre_validate_timeline",
] as const

export type SreToolName = (typeof SRE_TOOL_NAMES)[number]

function assertActive(toolCtx: PluginToolContext, lifecycleSignal?: AbortSignal): void {
  if (lifecycleSignal?.aborted || toolCtx.signal?.aborted) {
    throw new Error("sre tool execution aborted")
  }
}

const TIME_RANGE_PROPS = {
  environment: { type: "string", minLength: 1 },
  startTime: { type: "string", format: "date-time" },
  endTime: { type: "string", format: "date-time" },
}

export function createSreTools(ctx: SrePluginContext, lifecycleSignal?: AbortSignal): PluginTool[] {
  const runtime = createSreRuntime(ctx)
  return [
    {
      name: "sre_query_logs",
      pluginId: ctx.pluginId,
      definition: {
        name: "sre_query_logs",
        description:
          "Query read-only gateway, MaaS, and vLLM log evidence for an explicit environment and time window.",
        parametersSchema: {
          type: "object",
          properties: {
            ...TIME_RANGE_PROPS,
            services: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: 12,
            },
            traceId: { type: "string", minLength: 1 },
            requestId: { type: "string", minLength: 1 },
            keywords: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: 12,
            },
          },
          required: ["environment", "startTime", "endTime"],
          additionalProperties: false,
        },
      },
      execute: async (args, toolCtx) => {
        assertActive(toolCtx, lifecycleSignal)
        return runtime.queryLogs(args as unknown as Parameters<typeof runtime.queryLogs>[0])
      },
    },
    {
      name: "sre_query_trace",
      pluginId: ctx.pluginId,
      definition: {
        name: "sre_query_trace",
        description:
          "Query read-only trace spans for a trace_id or request_id, returning the call skeleton and span durations.",
        parametersSchema: {
          type: "object",
          properties: {
            environment: { type: "string", minLength: 1 },
            traceId: { type: "string", minLength: 1 },
            requestId: { type: "string", minLength: 1 },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
          },
          required: ["environment"],
          anyOf: [{ required: ["traceId"] }, { required: ["requestId"] }],
          additionalProperties: false,
        },
      },
      execute: async (args, toolCtx) => {
        assertActive(toolCtx, lifecycleSignal)
        return runtime.queryTrace(args as unknown as Parameters<typeof runtime.queryTrace>[0])
      },
    },
    {
      name: "sre_query_metrics",
      pluginId: ctx.pluginId,
      definition: {
        name: "sre_query_metrics",
        description:
          "Query read-only Prometheus-style metric evidence for an explicit environment and time window.",
        parametersSchema: {
          type: "object",
          properties: {
            ...TIME_RANGE_PROPS,
            jobs: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: 12,
            },
            metrics: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: 24,
            },
            labels: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["environment", "startTime", "endTime"],
          additionalProperties: false,
        },
      },
      execute: async (args, toolCtx) => {
        assertActive(toolCtx, lifecycleSignal)
        return runtime.queryMetrics(args as unknown as Parameters<typeof runtime.queryMetrics>[0])
      },
    },
    {
      name: "sre_validate_timeline",
      pluginId: ctx.pluginId,
      definition: {
        name: "sre_validate_timeline",
        description:
          "Validate the SRE Agent's drafted incident timeline before final response. Every row must cite real evidence.",
        parametersSchema: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  time: { type: "string", minLength: 1 },
                  component: { type: "string", minLength: 1 },
                  event: { type: "string", minLength: 1 },
                  signals: { type: "array", items: { type: "string" } },
                  evidenceIds: { type: "array", minItems: 1, items: { type: "string" } },
                  sources: { type: "array", minItems: 1, items: { type: "string" } },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  flags: { type: "array", items: { type: "string" } },
                  notes: { type: "string" },
                },
                required: [
                  "time",
                  "component",
                  "event",
                  "signals",
                  "evidenceIds",
                  "sources",
                  "confidence",
                  "flags",
                ],
                additionalProperties: false,
              },
            },
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", minLength: 1 },
                  evidenceIds: { type: "array", items: { type: "string" } },
                },
                required: ["text", "evidenceIds"],
                additionalProperties: false,
              },
            },
            recommendations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", minLength: 1 },
                  evidenceIds: { type: "array", items: { type: "string" } },
                },
                required: ["text", "evidenceIds"],
                additionalProperties: false,
              },
            },
          },
          required: ["rows"],
          additionalProperties: false,
        },
      },
      execute: async (args, toolCtx) => {
        assertActive(toolCtx, lifecycleSignal)
        return runtime.validateTimeline(args as unknown as SreTimelineDraft)
      },
    },
  ]
}
