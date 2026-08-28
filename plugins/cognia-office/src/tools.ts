import type { PluginTool } from "@cognia/plugin-sdk"
import type { WorkbookOperation } from "./model"
import { createOfficeRuntime, type OfficePluginContext } from "./runtime"

export const OFFICE_TOOL_NAMES = [
  "office_create_workbook",
  "office_import_xlsx",
  "office_inspect_workbook",
  "office_apply_operations",
  "office_validate_workbook",
  "office_preview_workbook",
  "office_export_xlsx",
  "office_sync_lark",
] as const

const artifactIdSchema = { type: "string", minLength: 1 } as const

export function createOfficeTools(ctx: OfficePluginContext): PluginTool[] {
  const runtime = createOfficeRuntime(ctx)
  return [
    tool(
      OFFICE_TOOL_NAMES[0],
      "Create a native XLSX-ready workbook artifact from deterministic workbook operations.",
      {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          sheetTitle: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 },
          operations: operationArraySchema,
        },
        required: ["title"],
        additionalProperties: false,
      },
      (args, toolCtx) =>
        runtime.create({
          ...(args as {
            title: string
            sheetTitle?: string
            content?: string
            operations?: WorkbookOperation[]
          }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        })
    ),
    tool(
      OFFICE_TOOL_NAMES[1],
      "Import an XLSX attachment handle, or open the user file picker when no handle is supplied.",
      {
        type: "object",
        properties: {
          handle: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      (args, toolCtx) =>
        runtime.importXlsx({
          ...(args as { handle?: string; title?: string }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        })
    ),
    tool(
      OFFICE_TOOL_NAMES[2],
      "Inspect workbook sheets, version, populated cells, merges, and compatibility warnings.",
      artifactOnlySchema,
      (args) => runtime.inspect((args as { artifactId: string }).artifactId)
    ),
    tool(
      OFFICE_TOOL_NAMES[3],
      "Atomically apply deterministic workbook operations with optimistic version checking.",
      {
        type: "object",
        properties: {
          artifactId: artifactIdSchema,
          expectedVersion: { type: "integer", minimum: 1 },
          operations: operationArraySchema,
          changeDescription: { type: "string", minLength: 1 },
        },
        required: ["artifactId", "expectedVersion", "operations"],
        additionalProperties: false,
      },
      (args) =>
        runtime.applyOperations(
          args as {
            artifactId: string
            expectedVersion: number
            operations: WorkbookOperation[]
            changeDescription?: string
          }
        )
    ),
    tool(
      OFFICE_TOOL_NAMES[4],
      "Validate a workbook before export and return actionable error/warning findings.",
      artifactOnlySchema,
      (args) => runtime.validate((args as { artifactId: string }).artifactId)
    ),
    tool(
      OFFICE_TOOL_NAMES[5],
      "Open the read-only workbook preview.",
      artifactOnlySchema,
      (args) => {
        const artifactId = (args as { artifactId: string }).artifactId
        runtime.inspect(artifactId)
        ctx.artifact.openArtifact(artifactId)
        return { ok: true, artifactId }
      }
    ),
    tool(
      OFFICE_TOOL_NAMES[6],
      "Validate and download a native XLSX workbook.",
      {
        type: "object",
        properties: {
          artifactId: artifactIdSchema,
          suggestedName: { type: "string", minLength: 1 },
          allowUnsupportedFeatureLoss: {
            type: "boolean",
            description:
              "Required to export an imported workbook that contains unsupported OOXML features.",
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
        return runtime.exportXlsx(
          input.artifactId,
          input.suggestedName,
          input.allowUnsupportedFeatureLoss
        )
      }
    ),
    tool(
      OFFICE_TOOL_NAMES[7],
      "Create a Lark Sheets workbook through the audited built-in Lark skill bridge.",
      artifactOnlySchema,
      (args, toolCtx) => {
        if (!toolCtx.sessionId) throw new Error("office_sync_lark requires a chat session")
        return runtime.syncLark(
          (args as { artifactId: string }).artifactId,
          toolCtx.sessionId,
          toolCtx.signal
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
    pluginId: "cognia-office",
    definition: { name, description, parametersSchema },
    execute: async (...args) => execute(...args),
  }
}

const artifactOnlySchema = {
  type: "object",
  properties: { artifactId: artifactIdSchema },
  required: ["artifactId"],
  additionalProperties: false,
}

const cellSchema = {
  type: "object",
  properties: {
    type: { enum: ["string", "number", "boolean", "date", "blank", "error"] },
    value: { type: ["string", "number", "boolean"] },
    formula: { type: "string", minLength: 1 },
    style: {
      type: "object",
      properties: {
        numberFormat: { type: "string", minLength: 1 },
        font: {
          type: "object",
          properties: {
            bold: { type: "boolean" },
            italic: { type: "boolean" },
            color: { type: "string", pattern: "^#?[0-9A-Fa-f]{6,8}$" },
          },
          additionalProperties: false,
        },
        fill: {
          type: "object",
          properties: { color: { type: "string", pattern: "^#?[0-9A-Fa-f]{6,8}$" } },
          required: ["color"],
          additionalProperties: false,
        },
        alignment: {
          type: "object",
          properties: {
            horizontal: { enum: ["left", "center", "right"] },
            vertical: { enum: ["top", "middle", "bottom"] },
            wrapText: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  required: ["type"],
  additionalProperties: false,
} as const

const operationBaseProperties = {
  sheet: { type: "string", minLength: 1 },
} as const

const operationArraySchema = {
  type: "array",
  minItems: 1,
  maxItems: 500,
  items: {
    oneOf: [
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "setCell" },
          cell: { type: "string", pattern: "^[A-Za-z]{1,3}[1-9][0-9]*$" },
          value: cellSchema,
        },
        required: ["op", "sheet", "cell", "value"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "setRange" },
          range: {
            type: "string",
            pattern: "^[A-Za-z]{1,3}[1-9][0-9]*:[A-Za-z]{1,3}[1-9][0-9]*$",
          },
          values: {
            type: "array",
            minItems: 1,
            items: { type: "array", minItems: 1, items: cellSchema },
          },
        },
        required: ["op", "sheet", "range", "values"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          op: { const: "addSheet" },
          title: { type: "string", minLength: 1, maxLength: 31 },
          index: { type: "integer", minimum: 0 },
        },
        required: ["op", "title"],
        additionalProperties: false,
      },
      ...["deleteSheet", "unmerge"].map((op) => ({
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: op },
          ...(op === "unmerge"
            ? {
                range: {
                  type: "string",
                  pattern: "^[A-Za-z]{1,3}[1-9][0-9]*:[A-Za-z]{1,3}[1-9][0-9]*$",
                },
              }
            : {}),
        },
        required: op === "unmerge" ? ["op", "sheet", "range"] : ["op", "sheet"],
        additionalProperties: false,
      })),
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "renameSheet" },
          title: { type: "string", minLength: 1, maxLength: 31 },
        },
        required: ["op", "sheet", "title"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "reorderSheet" },
          index: { type: "integer", minimum: 0 },
        },
        required: ["op", "sheet", "index"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "merge" },
          range: {
            type: "string",
            pattern: "^[A-Za-z]{1,3}[1-9][0-9]*:[A-Za-z]{1,3}[1-9][0-9]*$",
          },
        },
        required: ["op", "sheet", "range"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "setFilter" },
          range: {
            type: "string",
            pattern: "^[A-Za-z]{1,3}[1-9][0-9]*:[A-Za-z]{1,3}[1-9][0-9]*$",
          },
        },
        required: ["op", "sheet"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "setFreeze" },
          rows: { type: "integer", minimum: 0 },
          columns: { type: "integer", minimum: 0 },
        },
        required: ["op", "sheet"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "setRowDimension" },
          row: { type: "integer", minimum: 1 },
          height: { type: "number", exclusiveMinimum: 0 },
          hidden: { type: "boolean" },
        },
        required: ["op", "sheet", "row"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "setColumnDimension" },
          column: { type: "string", pattern: "^[A-Za-z]{1,3}$" },
          width: { type: "number", exclusiveMinimum: 0 },
          hidden: { type: "boolean" },
        },
        required: ["op", "sheet", "column"],
        additionalProperties: false,
      },
    ],
  },
}
