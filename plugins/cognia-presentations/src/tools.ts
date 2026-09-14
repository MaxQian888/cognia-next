import type { PluginToolDef, PluginToolRegistration } from "@cognia/plugin-sdk"
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
/**
 * Closed shape for slide elements. `type` is enumerated and every per-type
 * field is declared so the model receives a fully-described element contract;
 * per-type required-field enforcement (e.g. `rows` for tables) happens in
 * `assertSlideElements` inside the model layer, which a JSON-Schema
 * discriminated union cannot reach through the host's schema→zod bridge.
 */
const slideElement = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    type: { enum: ["text", "shape", "image", "table", "chart"] },
    x: { type: "number", description: "Left edge in inches" },
    y: { type: "number", description: "Top edge in inches" },
    width: { type: "number", description: "Width in inches" },
    height: { type: "number", description: "Height in inches" },
    text: { type: "string", description: "Text content (text/shape)" },
    fontSize: { type: "number", minimum: 1, description: "Points (text)" },
    bold: { type: "boolean" },
    color: { type: "string", description: "Hex color without #, e.g. 1F2937" },
    shape: { enum: ["rect", "roundRect", "ellipse"] },
    fill: { type: "string", description: "Hex fill without # (shape)" },
    line: { type: "string", description: "Hex outline without # (shape)" },
    dataBase64: { type: "string", description: "Base64 image bytes (image)" },
    mimeType: { enum: ["image/png", "image/jpeg"] },
    alt: { type: "string", description: "Alt text (image, required for accessibility)" },
    rows: {
      type: "array",
      items: { type: "array", items: { type: "string" } },
      description: "Table rows of cell strings (table)",
    },
    labels: { type: "array", items: { type: "string" }, description: "Chart labels" },
    values: { type: "array", items: { type: "number" }, description: "Chart values" },
    title: { type: "string", description: "Chart title" },
  },
  required: ["id", "type", "x", "y", "width", "height"],
  additionalProperties: false,
} as const
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
      elements: { type: "array", items: slideElement },
      speakerNotes: { type: "string" },
      sourceNote: { type: "string" },
    },
    required: ["op"],
    additionalProperties: false,
  },
} as const
export function createPresentationTools(ctx: PresentationsPluginContext): PluginToolRegistration[] {
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
        }),
      { timeoutMs: 120_000 }
    ),
    tool(
      PRESENTATION_TOOL_NAMES[2],
      "Inspect slides, elements, speaker notes, sources, and compatibility findings.",
      artifactOnly,
      (args) => runtime.inspect((args as { artifactId: string }).artifactId),
      { retryable: true }
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
      (args) => runtime.validate((args as { artifactId: string }).artifactId),
      { retryable: true }
    ),
    tool(
      PRESENTATION_TOOL_NAMES[5],
      "Open the plugin-owned responsive slide preview.",
      artifactOnly,
      (args) => runtime.preview((args as { artifactId: string }).artifactId),
      { retryable: true }
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
      },
      { timeoutMs: 60_000 }
    ),
  ]
}
function tool(
  name: string,
  description: string,
  parametersSchema: Record<string, unknown>,
  execute: (...args: Parameters<PluginToolRegistration["execute"]>) => unknown | Promise<unknown>,
  options?: Pick<PluginToolDef, "retryable" | "timeoutMs">
): PluginToolRegistration {
  return {
    name,
    definition: { name, description, parametersSchema, ...options },
    execute: async (...args) => execute(...args),
  }
}
