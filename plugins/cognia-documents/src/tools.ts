import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
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

/** A file dialog stays open while the user decides — outlast the 30 s default. */
const FILE_DIALOG_TIMEOUT_MS = 120_000
/** Building and re-opening a large DOCX package can outrun the default too. */
const PACKAGE_TIMEOUT_MS = 60_000

export function createDocumentTools(ctx: DocumentsPluginContext): PluginToolRegistration[] {
  const runtime = createDocumentsRuntime(ctx)
  return [
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[0],
      definition: {
        name: DOCUMENT_TOOL_NAMES[0],
        description: "Create a structured native DOCX-ready document artifact.",
        parametersSchema: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            text: { type: "string" },
            operations: operationSchema,
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
      execute: async (args, tc) =>
        runtime.create({
          ...(args as { title: string; text?: string; operations?: DocumentOperation[] }),
          sessionId: tc.sessionId,
          messageId: tc.messageId,
        }),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[1],
      definition: {
        name: DOCUMENT_TOOL_NAMES[1],
        description:
          "Import an authorized DOCX attachment, or open the file picker when no handle is given.",
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
        runtime.importDocx(
          {
            ...(args as { handle?: string; title?: string }),
            sessionId: tc.sessionId,
            messageId: tc.messageId,
          },
          { signal: tc.signal, reportProgress: tc.reportProgress }
        ),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[2],
      definition: {
        name: DOCUMENT_TOOL_NAMES[2],
        description:
          "Inspect document blocks, comments, tracked changes, and compatibility findings.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.inspect((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[3],
      definition: {
        name: DOCUMENT_TOOL_NAMES[3],
        description:
          "Apply document edits, comments, tracked changes, and review actions atomically.",
        parametersSchema: {
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
      },
      execute: async (args) =>
        runtime.apply(
          args as {
            artifactId: string
            expectedVersion: number
            operations: DocumentOperation[]
            changeDescription?: string
          }
        ),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[4],
      definition: {
        name: DOCUMENT_TOOL_NAMES[4],
        description: "Generate, reopen, and validate the DOCX package.",
        parametersSchema: artifactOnly,
        timeoutMs: PACKAGE_TIMEOUT_MS,
      },
      execute: async (args, tc) =>
        runtime.validate((args as { artifactId: string }).artifactId, {
          signal: tc.signal,
          reportProgress: tc.reportProgress,
        }),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[5],
      definition: {
        name: DOCUMENT_TOOL_NAMES[5],
        description: "Open the plugin-owned document preview.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.preview((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[6],
      definition: {
        name: DOCUMENT_TOOL_NAMES[6],
        description:
          "Validate and save a native DOCX file. Desktop shows a save dialog, mobile saves to " +
          "Documents/cognia/exports, web downloads it; relay the returned message to the user.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            suggestedName: {
              type: "string",
              minLength: 1,
              description: "File name without a path; .docx is added when missing.",
            },
            allowUnsupportedFeatureLoss: {
              type: "boolean",
              description:
                "Required to export an imported DOCX containing unsupported native features.",
            },
          },
          required: ["artifactId"],
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args, tc) => {
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
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[7],
      definition: {
        name: DOCUMENT_TOOL_NAMES[7],
        description: "List the saved version history of a document artifact.",
        parametersSchema: artifactOnly,
      },
      execute: async (args) => runtime.listVersions((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[8],
      definition: {
        name: DOCUMENT_TOOL_NAMES[8],
        description: "Restore a document artifact to a previously saved version.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId,
            versionId: { type: "string", minLength: 1 },
            expectedVersion: { type: "integer", minimum: 1 },
          },
          required: ["artifactId", "versionId", "expectedVersion"],
          additionalProperties: false,
        },
      },
      execute: async (args) =>
        runtime.restoreVersion(
          args as { artifactId: string; versionId: string; expectedVersion: number }
        ),
    }),
    definePluginTool({
      name: DOCUMENT_TOOL_NAMES[9],
      definition: {
        name: DOCUMENT_TOOL_NAMES[9],
        description:
          "Export a chat session transcript as a DOCX file (saved like documents_export_docx).",
        parametersSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              minLength: 1,
              description: "Defaults to the calling session when omitted.",
            },
            suggestedName: {
              type: "string",
              minLength: 1,
              description: "File name without a path; .docx is added when missing.",
            },
          },
          additionalProperties: false,
        },
        timeoutMs: FILE_DIALOG_TIMEOUT_MS,
      },
      execute: async (args, tc) => {
        const i = args as { sessionId?: string; suggestedName?: string }
        const sessionId = i.sessionId ?? tc.sessionId
        if (!sessionId)
          return {
            ok: false as const,
            error: "No chat session to export: pass sessionId when calling outside a session.",
          }
        return runtime.exportTranscript(
          { sessionId, suggestedName: i.suggestedName },
          { signal: tc.signal, reportProgress: tc.reportProgress }
        )
      },
    }),
  ]
}
