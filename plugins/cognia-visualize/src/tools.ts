import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
import { VISUALIZATION_PROFILES, type VisualizationSpec } from "./model"
import { createVisualizeRuntime, type VisualizePluginContext } from "./runtime"

export const VISUALIZE_TOOL_NAMES = [
  "visualize_recommend",
  "visualize_create",
  "visualize_inspect",
  "visualize_list",
  "visualize_update",
  "visualize_validate",
  "visualize_preview",
  "visualize_export",
  "visualize_export_report",
] as const

/** A save dialog stays open while the user decides — outlast the 30 s default. */
const FILE_DIALOG_TIMEOUT_MS = 120_000
const artifactId = { type: "string", minLength: 1 } as const
const artifactOnly = {
  type: "object",
  properties: { artifactId },
  required: ["artifactId"],
  additionalProperties: false,
}
const specSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    profile: {
      type: "string",
      enum: [...VISUALIZATION_PROFILES],
      description:
        "sankey/network/process need source+target per data point; timeline/gantt need start " +
        "(end optional); scatter plots x/y (else index/value); heatmap is group × label; " +
        "for a histogram, bin the values first and use bar.",
    },
    data: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1 },
          value: { type: "number" },
          group: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          source: { type: "string" },
          target: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
        },
        required: ["label", "value"],
        additionalProperties: false,
      },
    },
    unit: { type: "string" },
    sourceNote: { type: "string" },
    palette: { type: "array", items: { type: "string" } },
    accessibility: {
      type: "object",
      properties: { summary: { type: "string" }, showDataTable: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  required: ["title", "profile", "data"],
  additionalProperties: false,
} as const

export function createVisualizeTools(ctx: VisualizePluginContext): PluginToolRegistration[] {
  const runtime = createVisualizeRuntime(ctx)
  return [
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[0],
      definition: {
        name: VISUALIZE_TOOL_NAMES[0],
        description: `Recommend one of the ${VISUALIZATION_PROFILES.length} visualization profiles for an analytical intent.`,
        parametersSchema: {
          type: "object",
          properties: { intent: { type: "string", minLength: 1 } },
          required: ["intent"],
          additionalProperties: false,
        },
      },
      execute: async (args) => runtime.recommend((args as { intent: string }).intent),
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[1],
      definition: {
        name: VISUALIZE_TOOL_NAMES[1],
        description: "Create a plugin-owned accessible visualization artifact.",
        parametersSchema: specSchema,
      },
      execute: async (args, tc) =>
        runtime.create({
          ...(args as Parameters<typeof runtime.create>[0]),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        }),
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[2],
      definition: {
        name: VISUALIZE_TOOL_NAMES[2],
        description: "Inspect the visualization spec and validation findings.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.inspect((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[3],
      definition: {
        name: VISUALIZE_TOOL_NAMES[3],
        description:
          "List this plugin's visualization artifacts in the current session (or another " +
          "session by id; allSessions lists every session).",
        parametersSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              minLength: 1,
              description: "Defaults to the calling session.",
            },
            allSessions: {
              type: "boolean",
              description: "List visualizations from every session instead of one.",
            },
          },
          additionalProperties: false,
        },
      },
      execute: async (args, tc) => {
        const input = args as { sessionId?: string; allSessions?: boolean }
        return runtime.list({
          sessionId: input.allSessions ? undefined : (input.sessionId ?? tc.sessionId),
        })
      },
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[4],
      definition: {
        name: VISUALIZE_TOOL_NAMES[4],
        description: "Replace a visualization spec with optimistic version checking.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            expectedVersion: { type: "integer", minimum: 1 },
            spec: specSchema,
            changeDescription: { type: "string" },
          },
          required: ["artifactId", "expectedVersion", "spec"],
          additionalProperties: false,
        },
      },
      execute: async (args) =>
        runtime.update(
          args as {
            artifactId: string
            expectedVersion: number
            spec: VisualizationSpec
            changeDescription?: string
          }
        ),
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[5],
      definition: {
        name: VISUALIZE_TOOL_NAMES[5],
        description: "Validate data, profile requirements, and accessibility fallback.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.validate((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[6],
      definition: {
        name: VISUALIZE_TOOL_NAMES[6],
        description: "Open the plugin-owned responsive visualization preview.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.preview((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[7],
      definition: {
        name: VISUALIZE_TOOL_NAMES[7],
        description:
          "Export the validated visualization as SVG, HTML, or JSON. Desktop shows a save " +
          "dialog, mobile saves to Documents/cognia/exports, web downloads it; relay the " +
          "returned message to the user.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            format: { enum: ["svg", "html", "json"] },
            suggestedName: {
              type: "string",
              description: "File name without a path; the format's extension is enforced.",
            },
          },
          required: ["artifactId", "format"],
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args) =>
        runtime.export(
          args as { artifactId: string; format: "svg" | "html" | "json"; suggestedName?: string }
        ),
    }),
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[8],
      definition: {
        name: VISUALIZE_TOOL_NAMES[8],
        description:
          "Export every visualization in a chat session as one standalone HTML report and save " +
          "it (same save behavior as visualize_export).",
        parametersSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              minLength: 1,
              description: "Defaults to the calling session.",
            },
            suggestedName: {
              type: "string",
              description: "File name without a path; .html is enforced.",
            },
          },
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args, tc) => {
        const input = args as { sessionId?: string; suggestedName?: string }
        const sessionId = input.sessionId ?? tc.sessionId
        if (!sessionId)
          return {
            ok: false as const,
            error: "No chat session to report on: pass sessionId when calling outside a session.",
          }
        return runtime.exportReport({ sessionId, suggestedName: input.suggestedName })
      },
    }),
  ]
}
