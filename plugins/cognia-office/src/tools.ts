import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
import { MAX_STYLED_RANGE_CELLS, type WorkbookOperation } from "./model"
import { DEFAULT_READ_CELLS, MAX_READ_CELLS } from "./read-range"
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
  "office_read_range",
  "office_list_versions",
  "office_restore_version",
] as const

const artifactIdSchema = { type: "string", minLength: 1 } as const

/** A file dialog stays open while the user decides — outlast the 30 s default. */
const FILE_DIALOG_TIMEOUT_MS = 120_000
/** Creating a multi-sheet spreadsheet through the Lark API is several round trips. */
const LARK_SYNC_TIMEOUT_MS = 120_000

export function createOfficeTools(ctx: OfficePluginContext): PluginToolRegistration[] {
  const runtime = createOfficeRuntime(ctx)
  return [
    definePluginTool({
      name: OFFICE_TOOL_NAMES[0],
      definition: {
        name: OFFICE_TOOL_NAMES[0],
        description:
          "Create a native XLSX-ready workbook artifact from deterministic workbook operations. " +
          "Formulas are evaluated on commit (see recalculation). Returns a summary (sheets, used " +
          "ranges, findings), not the cells; read them back with office_read_range.",
        parametersSchema: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            sheetTitle: { type: "string", minLength: 1 },
            content: {
              type: "string",
              minLength: 1,
              description: "Optional CSV/TSV text to seed the first sheet.",
            },
            operations: operationArraySchema,
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
      execute: async (args, toolCtx) =>
        runtime.create({
          ...(args as {
            title: string
            sheetTitle?: string
            content?: string
            operations?: WorkbookOperation[]
          }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        }),
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[1],
      definition: {
        name: OFFICE_TOOL_NAMES[1],
        description:
          "Import an XLSX attachment handle, or open the user file picker when no handle is " +
          "supplied. Returns a summary; read cell contents with office_read_range.",
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
      execute: async (args, toolCtx) =>
        runtime.importXlsx({
          ...(args as { handle?: string; title?: string }),
          sessionId: toolCtx.sessionId,
          messageId: toolCtx.messageId,
        }),
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[2],
      definition: {
        name: OFFICE_TOOL_NAMES[2],
        description:
          "Inspect workbook version, sheets (used range, cell/formula/merge counts, filter, " +
          "freeze), and compatibility warnings. Use office_read_range for cell contents.",
        parametersSchema: artifactOnlySchema,
      },
      execute: async (args) => runtime.inspect((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[3],
      definition: {
        name: OFFICE_TOOL_NAMES[3],
        description:
          "Atomically apply deterministic workbook operations with optimistic version checking. " +
          "Structural edits (insert/delete rows or columns, rename/delete sheets) rewrite formula " +
          "references across every sheet the way Excel does; references into deleted cells " +
          "become #REF!. Every formula is then recalculated and its computed value stored. " +
          "recalculation lists error results (errorCells) and formulas the engine could not " +
          "evaluate (issues: circular → #REF!, unsupported or syntax → cached value kept, else " +
          "an error); fix those before relying on the numbers.",
        parametersSchema: {
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
      },
      execute: async (args) =>
        runtime.applyOperations(
          args as {
            artifactId: string
            expectedVersion: number
            operations: WorkbookOperation[]
            changeDescription?: string
          }
        ),
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[4],
      definition: {
        name: OFFICE_TOOL_NAMES[4],
        description:
          "Validate a workbook before export and return actionable error/warning findings.",
        parametersSchema: artifactOnlySchema,
      },
      execute: async (args) => runtime.validate((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[5],
      definition: {
        name: OFFICE_TOOL_NAMES[5],
        description:
          "Open the workbook preview for the user, who can also edit cells there (a human edit " +
          "is a new version: pass the current version as expectedVersion). To see the rendered " +
          "sheet yourself, call artifact_capture with the artifactId.",
        parametersSchema: artifactOnlySchema,
      },
      execute: async (args) => {
        const artifactId = (args as { artifactId: string }).artifactId
        runtime.inspect(artifactId)
        ctx.artifact.openArtifact(artifactId)
        return { ok: true, artifactId }
      },
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[6],
      definition: {
        name: OFFICE_TOOL_NAMES[6],
        description:
          "Validate and save a native XLSX workbook. Desktop shows a save dialog, mobile saves " +
          "to Documents/cognia/exports, web downloads it; relay the returned message to the user.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId: artifactIdSchema,
            suggestedName: {
              type: "string",
              minLength: 1,
              description: "File name without a path; .xlsx is added when missing.",
            },
            allowUnsupportedFeatureLoss: {
              type: "boolean",
              description:
                "Required to export an imported workbook that contains unsupported OOXML features.",
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
        return runtime.exportXlsx(
          input.artifactId,
          input.suggestedName,
          input.allowUnsupportedFeatureLoss
        )
      },
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[7],
      definition: {
        name: OFFICE_TOOL_NAMES[7],
        description:
          "Create a Lark Sheets workbook through the audited built-in Lark skill bridge.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId: artifactIdSchema,
            folderToken: {
              type: "string",
              minLength: 1,
              description: "Optional Lark Drive folder token to create the spreadsheet in.",
            },
          },
          required: ["artifactId"],
          additionalProperties: false,
        },
        timeoutMs: LARK_SYNC_TIMEOUT_MS,
      },
      execute: async (args, toolCtx) => {
        const input = args as { artifactId: string; folderToken?: string }
        if (!toolCtx.sessionId)
          return {
            ok: false as const,
            artifactId: input.artifactId,
            error: "office_sync_lark needs a chat session; call it from a conversation.",
          }
        return runtime.syncLark(input.artifactId, toolCtx.sessionId, {
          folderToken: input.folderToken,
          signal: toolCtx.signal,
        })
      },
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[8],
      definition: {
        name: OFFICE_TOOL_NAMES[8],
        description:
          "Read workbook cell values under a cell budget. Omit sheet to read every sheet's used " +
          'range; pass sheet (and optionally range) to read one block. format "grid" returns ' +
          'row-major values plus a formula map; "text" returns tab-separated text per sheet. ' +
          "truncated: true means the budget clipped the block — read the rest by range.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId: artifactIdSchema,
            sheet: { type: "string", minLength: 1, description: "Sheet id or title." },
            range: {
              ...rangeSchema,
              description: "A1 range on that sheet; defaults to its used range.",
            },
            maxCells: {
              type: "integer",
              minimum: 1,
              maximum: MAX_READ_CELLS,
              description: `Cell budget shared across sheets (default ${DEFAULT_READ_CELLS}).`,
            },
            includeFormulas: {
              type: "boolean",
              description: "Include formula text keyed by cell (default true).",
            },
            format: { enum: ["grid", "text"] },
          },
          required: ["artifactId"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const { artifactId, ...options } = args as {
          artifactId: string
          sheet?: string
          range?: string
          maxCells?: number
          includeFormulas?: boolean
          format?: "grid" | "text"
        }
        return runtime.readRange(artifactId, options)
      },
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[9],
      definition: {
        name: OFFICE_TOOL_NAMES[9],
        description: "List the saved version history of a workbook artifact.",
        parametersSchema: artifactOnlySchema,
      },
      execute: async (args) => runtime.listVersions((args as { artifactId: string }).artifactId),
    }),
    definePluginTool({
      name: OFFICE_TOOL_NAMES[10],
      definition: {
        name: OFFICE_TOOL_NAMES[10],
        description:
          "Restore a workbook artifact to a saved version (from office_list_versions). The " +
          "restore is itself a new version, so it can be undone the same way.",
        parametersSchema: {
          type: "object",
          properties: {
            artifactId: artifactIdSchema,
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
  ]
}

const rangeSchema = {
  type: "string",
  pattern: "^[A-Za-z]{1,3}[1-9][0-9]*(:[A-Za-z]{1,3}[1-9][0-9]*)?$",
} as const

const artifactOnlySchema = {
  type: "object",
  properties: { artifactId: artifactIdSchema },
  required: ["artifactId"],
  additionalProperties: false,
}

const styleSchema = {
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
} as const

const cellSchema = {
  type: "object",
  properties: {
    type: { enum: ["string", "number", "boolean", "date", "blank", "error"] },
    value: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      description: "Omit for formula cells: the computed result replaces it.",
    },
    formula: { type: "string", minLength: 1, description: "Excel formula, e.g. SUM(A1:A5)." },
    style: styleSchema,
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
      ...(["insertRows", "deleteRows"] as const).map((op) => ({
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: op },
          row: {
            type: "integer",
            minimum: 1,
            description: `1-based row index to ${op === "insertRows" ? "insert before" : "start deleting from"}.`,
          },
          count: { type: "integer", minimum: 1, description: "Number of rows (default 1)." },
        },
        required: ["op", "sheet", "row"],
        additionalProperties: false,
      })),
      ...(["insertColumns", "deleteColumns"] as const).map((op) => ({
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: op },
          column: {
            type: "string",
            pattern: "^[A-Za-z]{1,3}$",
            description: `Column letter to ${op === "insertColumns" ? "insert before" : "start deleting from"}.`,
          },
          count: { type: "integer", minimum: 1, description: "Number of columns (default 1)." },
        },
        required: ["op", "sheet", "column"],
        additionalProperties: false,
      })),
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "clearRange" },
          range: rangeSchema,
          target: {
            enum: ["all", "contents", "formats"],
            description:
              "all (default) removes the cells; contents keeps formatting; formats keeps values.",
          },
        },
        required: ["op", "sheet", "range"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "setRangeStyle" },
          range: {
            ...rangeSchema,
            description: `Range to format (at most ${MAX_STYLED_RANGE_CELLS} cells).`,
          },
          style: styleSchema,
          mode: {
            enum: ["merge", "replace"],
            description:
              "merge (default) layers the style over each cell's; replace overwrites it.",
          },
        },
        required: ["op", "sheet", "range", "style"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ...operationBaseProperties,
          op: { const: "appendRows" },
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 5000,
            items: { type: "array", minItems: 1, items: cellSchema },
            description: "Rows written below the last used row; rows may differ in length.",
          },
          column: {
            type: "string",
            pattern: "^[A-Za-z]{1,3}$",
            description: "Column the rows start in (default A).",
          },
        },
        required: ["op", "sheet", "rows"],
        additionalProperties: false,
      },
    ],
  },
}
