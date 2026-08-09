import type { PluginTool } from "@/types/plugin"
import type { DocumentOperation } from "./model"
import { createDocumentsRuntime, type DocumentsPluginContext } from "./runtime"

export const DOCUMENT_TOOL_NAMES = [
  "documents_create",
  "documents_import_docx",
  "documents_inspect",
  "documents_apply_operations",
  "documents_validate",
  "documents_preview",
  "documents_export_docx",
] as const
const artifactId = { type: "string", minLength: 1 } as const
const artifactOnly = {
  type: "object",
  properties: { artifactId },
  required: ["artifactId"],
  additionalProperties: false,
}

export function createDocumentTools(ctx: DocumentsPluginContext): PluginTool[] {
  const runtime = createDocumentsRuntime(ctx)
  return [
    tool(
      DOCUMENT_TOOL_NAMES[0],
      "Create a structured native DOCX-ready document artifact.",
      {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          text: { type: "string" },
          operations: operationSchema,
        },
        required: ["title"],
        additionalProperties: false,
      },
      (args, tc) =>
        runtime.create({
          ...(args as { title: string; text?: string; operations?: DocumentOperation[] }),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        })
    ),
    tool(
      DOCUMENT_TOOL_NAMES[1],
      "Import an authorized DOCX attachment or choose a DOCX file.",
      {
        type: "object",
        properties: {
          handle: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      (args, tc) =>
        runtime.importDocx({
          ...(args as { handle?: string; title?: string }),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        })
    ),
    tool(
      DOCUMENT_TOOL_NAMES[2],
      "Inspect document blocks, comments, tracked changes, and compatibility findings.",
      artifactOnly,
      (args) => runtime.inspect((args as { artifactId: string }).artifactId)
    ),
    tool(
      DOCUMENT_TOOL_NAMES[3],
      "Apply document edits, comments, tracked changes, and review actions atomically.",
      {
        type: "object",
        properties: {
          artifactId,
          expectedVersion: { type: "integer", minimum: 1 },
          operations: operationSchema,
          changeDescription: { type: "string", minLength: 1 },
        },
        required: ["artifactId", "expectedVersion", "operations"],
        additionalProperties: false,
      },
      (args) =>
        runtime.apply(
          args as {
            artifactId: string
            expectedVersion: number
            operations: DocumentOperation[]
            changeDescription?: string
          }
        )
    ),
    tool(
      DOCUMENT_TOOL_NAMES[4],
      "Generate, reopen, and validate the DOCX package.",
      artifactOnly,
      (args) => runtime.validate((args as { artifactId: string }).artifactId)
    ),
    tool(DOCUMENT_TOOL_NAMES[5], "Open the plugin-owned document preview.", artifactOnly, (args) =>
      runtime.preview((args as { artifactId: string }).artifactId)
    ),
    tool(
      DOCUMENT_TOOL_NAMES[6],
      "Validate and save a native DOCX file.",
      {
        type: "object",
        properties: {
          artifactId,
          suggestedName: { type: "string", minLength: 1 },
          allowUnsupportedFeatureLoss: {
            type: "boolean",
            description:
              "Required to export an imported DOCX containing unsupported native features.",
          },
        },
        required: ["artifactId"],
        additionalProperties: false,
      },
      (args) => {
        const i = args as {
          artifactId: string
          suggestedName?: string
          allowUnsupportedFeatureLoss?: boolean
        }
        return runtime.exportDocx(i.artifactId, i.suggestedName, i.allowUnsupportedFeatureLoss)
      }
    ),
  ]
}

const operationSchema = {
  type: "array",
  minItems: 1,
  maxItems: 500,
  items: {
    type: "object",
    properties: {
      op: {
        enum: [
          "appendParagraph",
          "appendHeading",
          "appendListItem",
          "appendTable",
          "replaceText",
          "addComment",
          "resolveComment",
          "acceptAllChanges",
          "stripComments",
        ],
      },
      text: { type: "string" },
      level: { type: "integer", minimum: 1, maximum: 3 },
      ordered: { type: "boolean" },
      rows: { type: "array", items: { type: "array", items: { type: "string" } } },
      blockId: { type: "string" },
      commentId: { type: "string" },
      author: { type: "string" },
      trackChange: { type: "boolean" },
    },
    required: ["op"],
    additionalProperties: false,
  },
} as const
function tool(
  name: string,
  description: string,
  parametersSchema: Record<string, unknown>,
  execute: (...args: Parameters<PluginTool["execute"]>) => unknown | Promise<unknown>
): PluginTool {
  return {
    name,
    pluginId: "cognia-documents",
    definition: { name, description, parametersSchema },
    execute: async (...args) => execute(...args),
  }
}
