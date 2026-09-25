import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
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
    dataBase64: {
      type: "string",
      description: "Raw base64 PNG/JPEG bytes without a data: URL prefix (image)",
    },
    mimeType: {
      enum: ["image/png", "image/jpeg"],
      description: "Must match the image bytes (PNG or JPEG magic number).",
    },
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
/** A file dialog stays open while the user decides — outlast the 30 s default. */
const FILE_DIALOG_TIMEOUT_MS = 120_000
/** Building and re-opening a PPTX with embedded images can outrun the default. */
const PACKAGE_TIMEOUT_MS = 60_000

export function createPresentationTools(ctx: PresentationsPluginContext): PluginToolRegistration[] {
  const runtime = createPresentationsRuntime(ctx)
  return [
    definePluginTool({
      name: PRESENTATION_TOOL_NAMES[0],
      definition: {
        name: PRESENTATION_TOOL_NAMES[0],
        description: "Create a structured native PPTX-ready presentation artifact.",
        parametersSchema: {
          type: "object",
          properties: { title: { type: "string", minLength: 1 }, operations },
          required: ["title"],
          additionalProperties: false,
        },
      },
      execute: async (args, tc) =>
        runtime.create({
          ...(args as { title: string; operations?: PresentationOperation[] }),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        }),
    }),
    definePluginTool({
      name: PRESENTATION_TOOL_NAMES[1],
      definition: {
        name: PRESENTATION_TOOL_NAMES[1],
        description:
          "Import an authorized PPTX attachment, or open the file picker when no handle is given.",
        parametersSchema: {
          type: "object",
          properties: {
            handle: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args, tc) =>
        runtime.importPptx({
          ...(args as { handle?: string; title?: string }),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        }),
    }),
    definePluginTool({
      name: PRESENTATION_TOOL_NAMES[2],
      definition: {
        name: PRESENTATION_TOOL_NAMES[2],
        description:
          "Inspect slides, elements, speaker notes, sources, and compatibility findings.",
        parametersSchema: artifactOnly,
        retryable: true,
      },
      execute: async (args) => runtime.inspect((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: PRESENTATION_TOOL_NAMES[3],
      definition: {
        name: PRESENTATION_TOOL_NAMES[3],
        description: "Apply slide operations atomically with optimistic version checking.",
        parametersSchema: {
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
      },
      execute: async (args) =>
        runtime.apply(
          args as {
            artifactId: string
            expectedVersion: number
            operations: PresentationOperation[]
            changeDescription?: string
          }
        ),
    }),
    definePluginTool({
      name: PRESENTATION_TOOL_NAMES[4],
      definition: {
        name: PRESENTATION_TOOL_NAMES[4],
        description:
          "Validate slide bounds, readability, accessibility, and native PPTX round-trip integrity.",
        parametersSchema: artifactOnly,
        retryable: true,
        timeoutMs: PACKAGE_TIMEOUT_MS,
      },
      execute: async (args) => runtime.validate((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: PRESENTATION_TOOL_NAMES[5],
      definition: {
        name: PRESENTATION_TOOL_NAMES[5],
        description: "Open the plugin-owned responsive slide preview.",
        parametersSchema: artifactOnly,
        retryable: true,
      },
      execute: async (args) => runtime.preview((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: PRESENTATION_TOOL_NAMES[6],
      definition: {
        name: PRESENTATION_TOOL_NAMES[6],
        description:
          "Validate and save a native PPTX presentation. Desktop shows a save dialog, mobile " +
          "saves to Documents/cognia/exports, web downloads it; relay the returned message.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            suggestedName: {
              type: "string",
              description: "File name without a path; .pptx is added when missing.",
            },
            allowUnsupportedFeatureLoss: {
              type: "boolean",
              description:
                "Required to export an imported PPTX containing unsupported native features.",
            },
          },
          required: ["artifactId"],
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args) => {
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
    }),
  ]
}
