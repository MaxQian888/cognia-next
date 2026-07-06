/**
 * Lark Sheets skill family (ADR-0026).
 *
 *   - read_range    read
 *   - find          read
 *   - create        write
 *   - write_range   write
 *   - append_rows   write
 *   - export        write   — exports to local file
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillMutation } from "../types"
import type { BuiltInSkillImAccess } from "../types"
import { argsToFlags, buildConfirmSurface, runLarkCli } from "./_helpers"

const FAMILY = "lark.sheets"
const PLATFORMS = ["lark"] as const

// Shared, described params (serialized to the model via manifest.ts).
const spreadsheetTokenParam = z
  .string()
  .min(1)
  .describe(
    'Spreadsheet token (looks like "shtcn…"). Find it via lark-drive search, or it is returned by lark.sheets.create.'
  )
const sheetIdParam = z.string().min(1).describe("Worksheet (tab) id within the spreadsheet.")
const grid = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
  .describe("2D array of cell values, outer = rows, inner = columns.")

function mk<S extends z.ZodTypeAny>(input: {
  id: string
  mcpToolName: string
  label: { en: string; "zh-CN": string }
  description: { en: string; "zh-CN": string }
  schema: S
  subcommand: readonly string[]
  mutation: BuiltInSkillMutation
  imAccess: BuiltInSkillImAccess
  confirmTitle?: string
  confirmSummary?: (args: z.infer<S>) => {
    summary: string
    details?: { label: string; value: string }[]
  }
}): BuiltInSkill<S> {
  const skill: BuiltInSkill<S> = {
    id: input.id,
    family: FAMILY,
    label: input.label,
    description: input.description,
    platforms: PLATFORMS,
    mutation: input.mutation,
    imAccess: input.imAccess,
    mcpToolName: input.mcpToolName,
    inputSchema: input.schema,
    execute: async (args, ctx) =>
      runLarkCli({
        args: [...input.subcommand, ...argsToFlags(args as Record<string, unknown>)],
        confirmed: ctx.hitlBypass === true,
      }),
  }
  if (input.mutation !== "read") {
    const title = input.confirmTitle ?? input.label.en
    skill.hitlSurface = (args) => {
      const c = input.confirmSummary?.(args) ?? { summary: `${input.label.en}.` }
      return buildConfirmSurface({
        surfaceId: `sfc_${input.id.replace(/\./g, "_")}_${Date.now().toString(36)}`,
        title,
        summary: c.summary,
        details: c.details,
      })
    }
  }
  return skill
}

registerBuiltInSkill(
  mk({
    id: "lark.sheets.read_range",
    mcpToolName: "lark_sheets_read_range",
    label: { en: "Read sheet range", "zh-CN": "读取表格区域" },
    description: {
      en: "Read a rectangular range from a Lark sheet (e.g. A1:D20).",
      "zh-CN": "读取 Lark 电子表格的指定区域（如 A1:D20）。",
    },
    schema: z.object({
      spreadsheetToken: spreadsheetTokenParam,
      sheetId: sheetIdParam,
      range: z.string().min(1).describe("A1 notation, e.g. A1:D20."),
    }),
    subcommand: ["sheets", "+read-range"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.sheets.find",
    mcpToolName: "lark_sheets_find",
    label: { en: "Find in sheet", "zh-CN": "在表格中查找" },
    description: {
      en: "Search for a value within a Lark sheet. Returns cell references.",
      "zh-CN": "在 Lark 电子表格中查找值，返回单元格位置。",
    },
    schema: z.object({
      spreadsheetToken: spreadsheetTokenParam,
      sheetId: sheetIdParam,
      query: z.string().min(1).describe("Value or text to find within the sheet."),
      matchCase: z.boolean().optional().describe("Case-sensitive match (default false)."),
      matchEntireCell: z
        .boolean()
        .optional()
        .describe("Require the whole cell to equal the query (default false)."),
    }),
    subcommand: ["sheets", "+find"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.sheets.create",
    mcpToolName: "lark_sheets_create",
    label: { en: "Create spreadsheet", "zh-CN": "新建表格" },
    description: {
      en: "Create a new Lark spreadsheet in the given folder.",
      "zh-CN": "在指定文件夹中新建 Lark 电子表格。",
    },
    schema: z.object({
      title: z.string().min(1).describe("Title of the new spreadsheet."),
      folderToken: z
        .string()
        .optional()
        .describe("Optional Drive folder token to create it in; omit for the root."),
    }),
    subcommand: ["sheets", "+create"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Create spreadsheet",
    confirmSummary: (args) => ({
      summary: `Create spreadsheet "${args.title}".`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.sheets.write_range",
    mcpToolName: "lark_sheets_write_range",
    label: { en: "Write sheet range", "zh-CN": "写入表格区域" },
    description: {
      en: "Overwrite a rectangular range in a Lark sheet with 2D values.",
      "zh-CN": "用二维数组覆盖 Lark 电子表格的指定区域。",
    },
    schema: z.object({
      spreadsheetToken: spreadsheetTokenParam,
      sheetId: sheetIdParam,
      range: z
        .string()
        .min(1)
        .describe("A1 range to overwrite; its size should match the values grid."),
      values: grid,
    }),
    subcommand: ["sheets", "+write-range"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Write sheet range",
    confirmSummary: (args) => ({
      summary: `Write ${args.values.length}×${args.values[0]?.length ?? 0} cells to ${args.range}.`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.sheets.append_rows",
    mcpToolName: "lark_sheets_append_rows",
    label: { en: "Append rows", "zh-CN": "追加行" },
    description: {
      en: "Append rows to the end of a Lark sheet.",
      "zh-CN": "在 Lark 电子表格末尾追加行。",
    },
    schema: z.object({
      spreadsheetToken: spreadsheetTokenParam,
      sheetId: sheetIdParam,
      rows: grid.describe("2D array of rows to append after the last used row."),
    }),
    subcommand: ["sheets", "+append-rows"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Append rows",
    confirmSummary: (args) => ({
      summary: `Append ${args.rows.length} row(s) to sheet ${args.sheetId}.`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.sheets.export",
    mcpToolName: "lark_sheets_export",
    label: { en: "Export sheet", "zh-CN": "导出表格" },
    description: {
      en: "Export a Lark sheet to a local file (xlsx / csv / pdf).",
      "zh-CN": "将 Lark 电子表格导出为本地文件（xlsx / csv / pdf）。",
    },
    schema: z.object({
      spreadsheetToken: spreadsheetTokenParam,
      format: z.enum(["xlsx", "csv", "pdf"]).describe("Export file format."),
      outputPath: z.string().min(1).describe("Local file path to write the exported file to."),
    }),
    subcommand: ["sheets", "+export"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Export sheet",
    confirmSummary: (args) => ({
      summary: `Export sheet ${args.spreadsheetToken} to ${args.outputPath} (${args.format}).`,
    }),
  })
)
