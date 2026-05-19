/**
 * Lark Doc skill family (ADR-0026).
 *
 *   - search        read
 *   - fetch         read
 *   - create        write
 *   - update        write
 *   - upload_image  write
 *   - delete        destructive (opt-in)
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillMutation } from "../types"
import type { BuiltInSkillImAccess } from "../types"
import { argsToFlags, buildConfirmSurface, runLarkCli } from "./_helpers"

const FAMILY = "lark.doc"
const PLATFORMS = ["lark"] as const

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
      const c = input.confirmSummary?.(args) ?? {
        summary: `${input.label.en}.`,
      }
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
    id: "lark.doc.search",
    mcpToolName: "lark_doc_search",
    label: { en: "Search docs", "zh-CN": "搜索文档" },
    description: {
      en: "Full-text search across the user's Lark cloud-docs.",
      "zh-CN": "在用户的 Lark 云空间中全文搜索。",
    },
    schema: z.object({
      query: z.string().min(1),
      pageSize: z.number().int().min(1).max(50).optional(),
    }),
    subcommand: ["docs", "+search"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.doc.fetch",
    mcpToolName: "lark_doc_fetch",
    label: { en: "Fetch doc", "zh-CN": "读取文档" },
    description: {
      en: "Read the content of a Lark doc by token. Supports range and outline modes.",
      "zh-CN": "按 token 读取 Lark 文档内容，支持 range / outline 模式。",
    },
    schema: z.object({
      docToken: z.string().min(1),
      mode: z.enum(["full", "outline", "range", "keyword", "section"]).optional(),
      format: z.enum(["simple", "with-ids", "full"]).optional(),
      keyword: z.string().optional(),
      sectionId: z.string().optional(),
    }),
    subcommand: ["docs", "+fetch", "--api-version", "v2"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.doc.create",
    mcpToolName: "lark_doc_create",
    label: { en: "Create doc", "zh-CN": "新建文档" },
    description: {
      en: "Create a Lark doc with the given title and body. Default body format is DocxXML.",
      "zh-CN": "新建 Lark 文档，默认正文格式为 DocxXML。",
    },
    schema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      format: z.enum(["docx-xml", "markdown"]).optional(),
      folderToken: z.string().optional(),
    }),
    subcommand: ["docs", "+create", "--api-version", "v2"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Create Lark doc",
    confirmSummary: (args) => ({
      summary: `Create doc "${args.title}".`,
      details: args.folderToken ? [{ label: "Folder", value: args.folderToken }] : undefined,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.doc.update",
    mcpToolName: "lark_doc_update",
    label: { en: "Update doc", "zh-CN": "编辑文档" },
    description: {
      en: "Apply an edit operation to a Lark doc. Supported ops: append, overwrite, block_replace, block_insert_after, block_delete.",
      "zh-CN": "对 Lark 文档应用编辑操作（append / overwrite / block_replace 等）。",
    },
    schema: z.object({
      docToken: z.string().min(1),
      operation: z.enum([
        "append",
        "overwrite",
        "block_replace",
        "block_insert_after",
        "block_delete",
        "str_replace",
      ]),
      payload: z.string().min(1).describe("DocxXML / Markdown / plain string"),
      anchor: z.string().optional().describe("Block id or string anchor for the op"),
    }),
    subcommand: ["docs", "+update", "--api-version", "v2"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Update Lark doc",
    confirmSummary: (args) => ({
      summary: `Apply ${args.operation} to doc ${args.docToken}.`,
      details: args.anchor ? [{ label: "Anchor", value: args.anchor }] : undefined,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.doc.upload_image",
    mcpToolName: "lark_doc_upload_image",
    label: { en: "Upload image to doc", "zh-CN": "向文档上传图片" },
    description: {
      en: "Upload a local image into a Lark doc at an optional anchor block.",
      "zh-CN": "向 Lark 文档上传本地图片，可指定锚定 block。",
    },
    schema: z.object({
      docToken: z.string().min(1),
      imagePath: z.string().min(1).describe("Absolute local path"),
      anchorBlockId: z.string().optional(),
    }),
    subcommand: ["docs", "+upload-image", "--api-version", "v2"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Upload image",
    confirmSummary: (args) => ({
      summary: `Upload ${args.imagePath} to doc ${args.docToken}.`,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.doc.delete",
    mcpToolName: "lark_doc_delete",
    label: { en: "Delete doc", "zh-CN": "删除文档" },
    description: {
      en: "Move a Lark doc to trash. Recoverable from trash for 30 days.",
      "zh-CN": "将 Lark 文档移至回收站（30 天内可恢复）。",
    },
    schema: z.object({
      docToken: z.string().min(1),
    }),
    subcommand: ["drive", "+delete"],
    mutation: "destructive",
    imAccess: "opt-in",
    confirmTitle: "Delete Lark doc",
    confirmSummary: (args) => ({
      summary: `Move doc ${args.docToken} to trash. Recoverable for 30 days.`,
    }),
  })
)
