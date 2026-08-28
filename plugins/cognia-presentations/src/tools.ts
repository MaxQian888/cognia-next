import type { PluginTool } from "@cognia/plugin-sdk"
import type { PresentationOperation } from "./model"
import { createPresentationsRuntime, type PresentationsPluginContext } from "./runtime"

export const PRESENTATION_TOOL_NAMES = [
  "presentations_create",
  "presentations_import_pptx",
  "presentations_inspect",
  "presentations_apply_operations",
  "presentations_validate",
  "presentations_preview",
  "presentations_export_pptx",
] as const
const artifactId = { type: "string", minLength: 1 } as const
const artifactOnly = {
  type: "object",
  properties: { artifactId },
  required: ["artifactId"],
  additionalProperties: false,
}
const operations = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: {
    type: "object",
    properties: {
      op: { enum: ["addSlide", "replaceSlide", "removeSlide", "reorderSlide"] },
      title: { type: "string" },
      slideId: { type: "string" },
      index: { type: "integer", minimum: 0 },
      elements: { type: "array", items: { type: "object", additionalProperties: true } },
      speakerNotes: { type: "string" },
      sourceNote: { type: "string" },
    },
    required: ["op"],
    additionalProperties: false,
  },
} as const
export function createPresentationTools(ctx: PresentationsPluginContext): PluginTool[] {
  const runtime = createPresentationsRuntime(ctx)
  return [
    tool(
      PRESENTATION_TOOL_NAMES[0],
      "Create a structured native PPTX-ready presentation artifact.",
      {
        type: "object",
        properties: { title: { type: "string", minLength: 1 }, operations },
        required: ["title"],
        additionalProperties: false,
      },
      (args, tc) =>
        runtime.create({
          ...(args as { title: string; operations?: PresentationOperation[] }),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        })
    ),
    tool(
      PRESENTATION_TOOL_NAMES[1],
      "Import an authorized PPTX attachment or choose a PPTX file.",
      {
        type: "object",
        properties: {
          handle: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      (args, tc) =>
        runtime.importPptx({
          ...(args as { handle?: string; title?: string }),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        })
    ),
    tool(
      PRESENTATION_TOOL_NAMES[2],
      "Inspect slides, elements, speaker notes, sources, and compatibility findings.",
      artifactOnly,
      (args) => runtime.inspect((args as { artifactId: string }).artifactId)
    ),
    tool(
      PRESENTATION_TOOL_NAMES[3],
      "Apply slide operations atomically with optimistic version checking.",
      {
        type: "object",
        properties: {
          artifactId,
          expectedVersion: { type: "integer", minimum: 1 },
          operations,
          changeDescription: { type: "string" },
        },
        required: ["artifactId", "expectedVersion", "operations"],
        additionalProperties: false,
      },
      (args) =>
        runtime.apply(
          args as {
            artifactId: string
            expectedVersion: number
            operations: PresentationOperation[]
          }
        )
    ),
    tool(
      PRESENTATION_TOOL_NAMES[4],
      "Validate slide bounds, readability, accessibility, and native PPTX round-trip integrity.",
      artifactOnly,
      (args) => runtime.validate((args as { artifactId: string }).artifactId)
    ),
    tool(
      PRESENTATION_TOOL_NAMES[5],
      "Open the plugin-owned responsive slide preview.",
      artifactOnly,
      (args) => runtime.preview((args as { artifactId: string }).artifactId)
    ),
    tool(
      PRESENTATION_TOOL_NAMES[6],
      "Validate and save a native PPTX presentation.",
      {
        type: "object",
        properties: {
          artifactId,
          suggestedName: { type: "string" },
          allowUnsupportedFeatureLoss: {
            type: "boolean",
            description:
              "Required to export an imported PPTX containing unsupported native features.",
          },
        },
        required: ["artifactId"],
        additionalProperties: false,
      },
      (args) => {
        const input = args as {
          artifactId: string
          suggestedName?: string
          allowUnsupportedFeatureLoss?: boolean
        }
        return runtime.exportPptx(
          input.artifactId,
          input.suggestedName,
          input.allowUnsupportedFeatureLoss
        )
      }
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
    pluginId: "cognia-presentations",
    definition: { name, description, parametersSchema },
    execute: async (...args) => execute(...args),
  }
}
