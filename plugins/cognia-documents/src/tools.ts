import type { PluginTool } from "@cognia/plugin-sdk"
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
  "documents_list_versions",
  "documents_restore_version",
  "documents_export_transcript",
] as const

const artifactId = { type: "string", minLength: 1 } as const
const artifactOnly = {
  type: "object",
  properties: { artifactId },
  required: ["artifactId"],
  additionalProperties: false,
}

const blockId = { type: "string", minLength: 1 }
const text = { type: "string", minLength: 1 }
const rows = {
  type: "array",
  minItems: 1,
  items: { type: "array", minItems: 1, items: { type: "string" } },
}

const blockInput = {
  type: "object",
  description: "Block to insert; the document assigns its id.",
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "paragraph" }, text },
      required: ["type", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "heading" },
        level: { type: "integer", minimum: 1, maximum: 3 },
        text,
      },
      required: ["type", "level", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "list-item" },
        ordered: { type: "boolean" },
        text,
      },
      required: ["type", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "table" }, rows },
      required: ["type", "rows"],
      additionalProperties: false,
    },
  ],
} as const

const operationSchema = {
  type: "array",
  minItems: 1,
  maxItems: 500,
  items: {
    oneOf: [
      {
        type: "object",
        properties: { op: { const: "setTitle" }, title: text },
        required: ["op", "title"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { op: { const: "appendParagraph" }, text },
        required: ["op", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "appendHeading" },
          text,
          level: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["op", "text", "level"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "appendListItem" },
          text,
          ordered: { type: "boolean" },
        },
        required: ["op", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { op: { const: "appendTable" }, rows },
        required: ["op", "rows"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "insertBlock" },
          afterBlockId: {
            type: "string",
            minLength: 1,
            description: "Insert after this block; omit to prepend at the start.",
          },
          block: blockInput,
        },
        required: ["op", "block"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { op: { const: "deleteBlock" }, blockId },
        required: ["op", "blockId"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "moveBlock" },
          blockId,
          toIndex: {
            type: "integer",
            minimum: 0,
            description: "Target index among blocks (clamped to the valid range).",
          },
        },
        required: ["op", "blockId", "toIndex"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "replaceText" },
          blockId,
          text,
          trackChange: {
            type: "boolean",
            description: "Record the edit as a pending tracked change for review.",
          },
        },
        required: ["op", "blockId", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "updateTableCell" },
          blockId,
          row: { type: "integer", minimum: 0 },
          column: { type: "integer", minimum: 0 },
          text: { type: "string" },
        },
        required: ["op", "blockId", "row", "column", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "addComment" },
          blockId,
          text,
          author: { type: "string", minLength: 1 },
        },
        required: ["op", "blockId", "text"],
        additionalProperties: false,
      },
      ...(["resolveComment", "reopenComment"] as const).map((op) => ({
        type: "object",
        properties: {
          op: { const: op },
          commentId: { type: "string", minLength: 1 },
        },
        required: ["op", "commentId"],
        additionalProperties: false,
      })),
      ...(["acceptChange", "rejectChange"] as const).map((op) => ({
        type: "object",
        properties: {
          op: { const: op },
          changeId: { type: "string", minLength: 1 },
        },
        required: ["op", "changeId"],
        additionalProperties: false,
      })),
      ...(["acceptAllChanges", "rejectAllChanges", "stripComments"] as const).map((op) => ({
        type: "object",
        properties: { op: { const: op } },
        required: ["op"],
        additionalProperties: false,
      })),
    ],
  },
} as const

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
        }),
      { access: "write" }
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
        runtime.importDocx(
          {
            ...(args as { handle?: string; title?: string }),
            sessionId: tc.sessionId,
            messageId: tc.messageId,
          },
          { signal: tc.signal, reportProgress: tc.reportProgress }
        ),
      { access: "read" }
    ),
    tool(
      DOCUMENT_TOOL_NAMES[2],
      "Inspect document blocks, comments, tracked changes, and compatibility findings.",
      artifactOnly,
      (args) => runtime.inspect((args as { artifactId: string }).artifactId),
      { access: "read" }
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
        ),
      { access: "write" }
    ),
    tool(
      DOCUMENT_TOOL_NAMES[4],
      "Generate, reopen, and validate the DOCX package.",
      artifactOnly,
      (args, tc) =>
        runtime.validate((args as { artifactId: string }).artifactId, {
          signal: tc.signal,
          reportProgress: tc.reportProgress,
        }),
      { access: "read" }
    ),
    tool(
      DOCUMENT_TOOL_NAMES[5],
      "Open the plugin-owned document preview.",
      artifactOnly,
      (args) => runtime.preview((args as { artifactId: string }).artifactId),
      { access: "read" }
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
      (args, tc) => {
        const i = args as {
          artifactId: string
          suggestedName?: string
          allowUnsupportedFeatureLoss?: boolean
        }
        return runtime.exportDocx(i.artifactId, i.suggestedName, i.allowUnsupportedFeatureLoss, {
          signal: tc.signal,
          reportProgress: tc.reportProgress,
        })
      },
      { access: "write" }
    ),
    tool(
      DOCUMENT_TOOL_NAMES[7],
      "List the saved version history of a document artifact.",
      artifactOnly,
      (args) => runtime.listVersions((args as { artifactId: string }).artifactId),
      { access: "read" }
    ),
    tool(
      DOCUMENT_TOOL_NAMES[8],
      "Restore a document artifact to a previously saved version.",
      {
        type: "object",
        properties: {
          artifactId,
          versionId: { type: "string", minLength: 1 },
          expectedVersion: { type: "integer", minimum: 1 },
        },
        required: ["artifactId", "versionId", "expectedVersion"],
        additionalProperties: false,
      },
      (args) =>
        runtime.restoreVersion(
          args as { artifactId: string; versionId: string; expectedVersion: number }
        ),
      { access: "write" }
    ),
    tool(
      DOCUMENT_TOOL_NAMES[9],
      "Export the current chat session transcript as a DOCX file.",
      {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            minLength: 1,
            description: "Defaults to the calling session when omitted.",
          },
          suggestedName: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      (args, tc) => {
        const i = args as { sessionId?: string; suggestedName?: string }
        const sessionId = i.sessionId ?? tc.sessionId
        if (!sessionId) throw new Error("sessionId is required outside a session context.")
        return runtime.exportTranscript(
          { sessionId, suggestedName: i.suggestedName },
          { signal: tc.signal, reportProgress: tc.reportProgress }
        )
      },
      { access: "read" }
    ),
  ]
}

function tool(
  name: string,
  description: string,
  parametersSchema: Record<string, unknown>,
  execute: (...args: Parameters<PluginTool["execute"]>) => unknown | Promise<unknown>,
  options?: { access?: "read" | "write" }
): PluginTool {
  return {
    name,
    pluginId: "cognia-documents",
    definition: { name, description, parametersSchema, access: options?.access },
    execute: async (...args) => execute(...args),
  }
}
