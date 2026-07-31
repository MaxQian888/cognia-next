/**
 * Lark Base (Bitable) skill family (ADR-0026).
 *
 *   - search           read
 *   - list_tables      read
 *   - list_records     read
 *   - read_record      read
 *   - append_records   write
 *   - update_record    write
 *   - create_field     write
 *   - delete_record    destructive (opt-in)
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillMutation } from "../types"
import type { BuiltInSkillImAccess } from "../types"
import { argsToFlags, buildConfirmSurface, larkAdapterIdFromCtx, runLarkCli } from "./_helpers"

const FAMILY = "lark.base"
const PLATFORMS = ["lark"] as const

// Shared, richly-described params. These schemas are serialized straight to the
// model (manifest.ts → z.toJSONSchema), so the `.describe()` text — including
// the discovery chain for each opaque token id — is what the model reads.
const appTokenParam = z
  .string()
  .min(1)
  .describe('Bitable base app token (looks like "bascn…"). Obtain it from lark.base.search.')
const tableIdParam = z
  .string()
  .min(1)
  .describe('Table id within the base (looks like "tbl…"). Obtain it from lark.base.list_tables.')
const recordIdParam = z
  .string()
  .min(1)
  .describe('Record id (looks like "rec…"). Obtain it from lark.base.list_records.')

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
        adapterId: larkAdapterIdFromCtx(ctx),
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
    id: "lark.base.search",
    mcpToolName: "lark_base_search",
    label: { en: "Search bases", "zh-CN": "搜索多维表格" },
    description: {
      en: "Search Lark Bitable bases by name.",
      "zh-CN": "按名称搜索 Lark 多维表格。",
    },
    schema: z.object({
      query: z.string().min(1).describe("Base name or keywords to search for."),
    }),
    subcommand: ["base", "+search"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.base.list_tables",
    mcpToolName: "lark_base_list_tables",
    label: { en: "List Bitable tables", "zh-CN": "列出多维表格的表" },
    description: {
      en: "List the tables inside a Lark Bitable base.",
      "zh-CN": "列出 Lark 多维表格中的所有表。",
    },
    schema: z.object({ appToken: appTokenParam }),
    subcommand: ["base", "+list-tables"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.base.list_records",
    mcpToolName: "lark_base_list_records",
    label: { en: "List records", "zh-CN": "列出记录" },
    description: {
      en: "List records from a Bitable table, with optional view and filter.",
      "zh-CN": "列出 Bitable 表中的记录，可选视图和过滤条件。",
    },
    schema: z.object({
      appToken: appTokenParam,
      tableId: tableIdParam,
      viewId: z.string().optional().describe('Optional view id ("vew…") to scope the listing.'),
      filter: z
        .string()
        .optional()
        .describe('Lark filter expression, e.g. CurrentValue.[Status]="Done".'),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max records to return (1–500; default is the server's page size)."),
    }),
    subcommand: ["base", "+list-records"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.base.read_record",
    mcpToolName: "lark_base_read_record",
    label: { en: "Read record", "zh-CN": "读取记录" },
    description: {
      en: "Read a single Bitable record by id.",
      "zh-CN": "按 id 读取单条 Bitable 记录。",
    },
    schema: z.object({
      appToken: appTokenParam,
      tableId: tableIdParam,
      recordId: recordIdParam,
    }),
    subcommand: ["base", "+read-record"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.base.append_records",
    mcpToolName: "lark_base_append_records",
    label: { en: "Append records", "zh-CN": "追加记录" },
    description: {
      en: "Append one or more records to a Bitable table.",
      "zh-CN": "向 Bitable 表追加一条或多条记录。",
    },
    schema: z.object({
      appToken: appTokenParam,
      tableId: tableIdParam,
      records: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'One or more records to add. Each object maps field NAME → value, e.g. {"Name":"Acme","Stage":"Lead"}.'
        ),
    }),
    subcommand: ["base", "+append-records"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Append Bitable records",
    confirmSummary: (args) => ({
      summary: `Append ${args.records.length} record(s) to table ${args.tableId}.`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.base.update_record",
    mcpToolName: "lark_base_update_record",
    label: { en: "Update record", "zh-CN": "更新记录" },
    description: {
      en: "Patch fields on a Bitable record.",
      "zh-CN": "更新单条 Bitable 记录的字段。",
    },
    schema: z.object({
      appToken: appTokenParam,
      tableId: tableIdParam,
      recordId: recordIdParam,
      fields: z
        .record(z.string(), z.unknown())
        .describe("Field NAME → new value map. Only the fields you include are changed."),
    }),
    subcommand: ["base", "+update-record"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Update Bitable record",
    confirmSummary: (args) => ({
      summary: `Update record ${args.recordId} in table ${args.tableId}.`,
      details: [{ label: "Fields", value: Object.keys(args.fields).join(", ") }],
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.base.create_field",
    mcpToolName: "lark_base_create_field",
    label: { en: "Create field", "zh-CN": "新建字段" },
    description: {
      en: "Add a new field (column) to a Bitable table.",
      "zh-CN": "向 Bitable 表新增字段（列）。",
    },
    schema: z.object({
      appToken: appTokenParam,
      tableId: tableIdParam,
      fieldName: z.string().min(1).describe("Display name of the new field (column)."),
      fieldType: z
        .string()
        .min(1)
        .describe(
          'Lark field type, e.g. "text", "number", "single_select", "multi_select", "date", "checkbox", "user", "phone", "url", "attachment". See the Lark Bitable field-type docs for the full set.'
        ),
      property: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Type-specific config, e.g. select options or number formatting. Shape depends on fieldType."
        ),
    }),
    subcommand: ["base", "+create-field"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Add Bitable field",
    confirmSummary: (args) => ({
      summary: `Add field "${args.fieldName}" (${args.fieldType}) to table ${args.tableId}.`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.base.delete_record",
    mcpToolName: "lark_base_delete_record",
    label: { en: "Delete record", "zh-CN": "删除记录" },
    description: {
      en: "Permanently delete a Bitable record. Cannot be undone.",
      "zh-CN": "永久删除一条 Bitable 记录，无法撤销。",
    },
    schema: z.object({
      appToken: appTokenParam,
      tableId: tableIdParam,
      recordId: recordIdParam,
    }),
    subcommand: ["base", "+delete-record"],
    mutation: "destructive",
    imAccess: "opt-in",
    confirmTitle: "Delete Bitable record",
    confirmSummary: (args) => ({
      summary: `Permanently delete record ${args.recordId} from table ${args.tableId}.`,
    }),
  })
)
