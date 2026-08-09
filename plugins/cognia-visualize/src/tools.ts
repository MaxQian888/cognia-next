import type { PluginTool } from "@/types/plugin"
import type { VisualizationSpec } from "./model"
import { createVisualizeRuntime, type VisualizePluginContext } from "./runtime"

export const VISUALIZE_TOOL_NAMES = [
  "visualize_recommend",
  "visualize_create",
  "visualize_inspect",
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
    tool(
      VISUALIZE_TOOL_NAMES[0],
      "Recommend one of 22 visualization profiles for an analytical intent.",
      {
        type: "object",
        properties: { intent: { type: "string", minLength: 1 } },
        required: ["intent"],
        additionalProperties: false,
      },
      (args) => runtime.recommend((args as { intent: string }).intent)
    ),
    tool(
      VISUALIZE_TOOL_NAMES[1],
      "Create a plugin-owned accessible visualization artifact.",
      specSchema,
      (args, tc) =>
        runtime.create({
          ...(args as Parameters<typeof runtime.create>[0]),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        })
    ),
    tool(
      VISUALIZE_TOOL_NAMES[2],
      "Inspect the visualization spec and validation findings.",
      artifactOnly,
      (args) => runtime.inspect((args as { artifactId: string }).artifactId)
    ),
    tool(
      VISUALIZE_TOOL_NAMES[3],
      "Replace a visualization spec with optimistic version checking.",
      {
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
      (args) =>
        runtime.update(
          args as { artifactId: string; expectedVersion: number; spec: VisualizationSpec }
        )
    ),
    tool(
      VISUALIZE_TOOL_NAMES[4],
      "Validate data, profile requirements, and accessibility fallback.",
      artifactOnly,
      (args) => runtime.validate((args as { artifactId: string }).artifactId)
    ),
    tool(
      VISUALIZE_TOOL_NAMES[5],
      "Open the plugin-owned responsive visualization preview.",
      artifactOnly,
      (args) => runtime.preview((args as { artifactId: string }).artifactId)
    ),
    tool(
      VISUALIZE_TOOL_NAMES[6],
      "Export the validated visualization as SVG, HTML, or JSON.",
      {
        type: "object",
        properties: {
          artifactId,
          format: { enum: ["svg", "html", "json"] },
          suggestedName: { type: "string" },
        },
        required: ["artifactId", "format"],
        additionalProperties: false,
      },
      (args) =>
        runtime.export(
          args as { artifactId: string; format: "svg" | "html" | "json"; suggestedName?: string }
        )
    ),
  ]
}
function tool(
  name: string,
  description: string,
  parametersSchema: Record<string, unknown>,
  execute: (...args: Parameters<PluginTool["execute"]>) => unknown | Promise<unknown>
): PluginTool {
  return {
    name,
    pluginId: "cognia-visualize",
    definition: { name, description, parametersSchema },
    execute: async (...args) => execute(...args),
  }
}
