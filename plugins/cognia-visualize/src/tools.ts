import { definePluginTool, type PluginTool } from "@cognia/plugin-sdk"
import type { VisualizationSpec } from "./model"
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
] as const
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
    profile: { type: "string" },
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

export function createVisualizeTools(ctx: VisualizePluginContext): PluginTool[] {
  const runtime = createVisualizeRuntime(ctx)
  return [
    definePluginTool({
      name: VISUALIZE_TOOL_NAMES[0],
      definition: {
        name: VISUALIZE_TOOL_NAMES[0],
        description: "Recommend one of 22 visualization profiles for an analytical intent.",
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
        description: "List this plugin's visualization artifacts, optionally scoped to a session.",
        parametersSchema: {
          type: "object",
          properties: { sessionId: { type: "string" } },
          additionalProperties: false,
        },
      },
      execute: async (args) => runtime.list(args as { sessionId?: string }),
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
          args as { artifactId: string; expectedVersion: number; spec: VisualizationSpec }
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
        description: "Export the validated visualization as SVG, HTML, or JSON.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            format: { enum: ["svg", "html", "json"] },
            suggestedName: { type: "string" },
          },
          required: ["artifactId", "format"],
          additionalProperties: false,
        },
      },
      execute: async (args) =>
        runtime.export(
          args as { artifactId: string; format: "svg" | "html" | "json"; suggestedName?: string }
        ),
    }),
  ]
}
