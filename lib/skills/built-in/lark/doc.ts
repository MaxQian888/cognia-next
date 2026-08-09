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
import { argsToFlags, buildConfirmSurface, larkAdapterIdFromCtx, runLarkCli } from "./_helpers"

const FAMILY = "lark.doc"
const PLATFORMS = ["lark"] as const

// Shared, described param (serialized to the model via manifest.ts).
const docTokenParam = z
  .string()
  .min(1)
  .describe(
    'Doc token (looks like "doxcn…"). Obtain it from lark.doc.search, or a wiki node resolves to one via lark.wiki.read_node.'
  )

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
  buildArgs?: (args: z.infer<S>) => string[]
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
        args: [
          ...input.subcommand,
          ...(input.buildArgs?.(args) ?? argsToFlags(args as Record<string, unknown>)),
        ],
        confirmed: ctx.hitlBypass === true,
        adapterId: larkAdapterIdFromCtx(ctx),
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
      query: z.string().min(1).describe("Keywords to search doc titles/content for."),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results to return (1–50)."),
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
      docToken: docTokenParam,
      mode: z
        .enum(["full", "outline", "range", "keyword", "section"])
        .optional()
        .describe(
          "How much to read: full body, outline only, a range, around a keyword, or one section (default full)."
        ),
      format: z
        .enum(["simple", "with-ids", "full"])
        .optional()
        .describe('Output detail; use "with-ids" to get block ids for later block-targeted edits.'),
      keyword: z
        .string()
        .optional()
        .describe('Required when mode="keyword": the text to center on.'),
      sectionId: z
        .string()
        .optional()
        .describe('Required when mode="section": the section/block id.'),
    }),
    subcommand: ["docs", "+fetch"],
    buildArgs: (args) =>
      argsToFlags({
        doc: args.docToken,
        scope: args.mode,
        detail: args.format,
        keyword: args.keyword,
        startBlockId: args.sectionId,
      }),
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
      title: z.string().min(1).describe("Title of the new doc."),
      body: z.string().min(1).describe("Document body, in the chosen format (default DocxXML)."),
      format: z
        .enum(["docx-xml", "markdown"])
        .optional()
        .describe("Body format: docx-xml (default) or markdown."),
      folderToken: z
        .string()
        .optional()
        .describe("Optional Drive folder token to create the doc in; omit for the root."),
    }),
    subcommand: ["docs", "+create"],
    buildArgs: (args) =>
      argsToFlags({
        title: args.title,
        content: args.body,
        docFormat: args.format === "markdown" ? "markdown" : "xml",
        parentToken: args.folderToken,
      }),
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
      docToken: docTokenParam,
      operation: z
        .enum([
          "append",
          "overwrite",
          "block_replace",
          "block_insert_after",
          "block_delete",
          "str_replace",
        ])
        .describe(
          "Edit op: append/overwrite the whole doc, replace/insert-after/delete a block (by id anchor), or str_replace (by string anchor)."
        ),
      payload: z
        .string()
        .min(1)
        .describe(
          "New content — DocxXML, Markdown, or a plain string, depending on the operation."
        ),
      anchor: z
        .string()
        .optional()
        .describe(
          "Block id (block_* ops) or the existing string to match (str_replace). Get block ids via lark.doc.fetch with format=with-ids."
        ),
    }),
    subcommand: ["docs", "+update"],
    buildArgs: (args) =>
      argsToFlags({
        doc: args.docToken,
        command: args.operation,
        content: args.payload,
        ...(args.operation === "str_replace" ? { pattern: args.anchor } : { blockId: args.anchor }),
      }),
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
      docToken: docTokenParam,
      imagePath: z.string().min(1).describe("Absolute local path to the image file."),
      anchorBlockId: z
        .string()
        .optional()
        .describe("Optional block id to insert the image after; omit to append at the end."),
    }),
    subcommand: ["docs", "+media-insert"],
    buildArgs: (args) =>
      argsToFlags({
        doc: args.docToken,
        file: args.imagePath,
        selectionWithEllipsis: args.anchorBlockId,
        type: "image",
      }),
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
      docToken: docTokenParam,
    }),
    subcommand: ["drive", "+delete"],
    buildArgs: (args) => argsToFlags({ fileToken: args.docToken, type: "docx" }),
    mutation: "destructive",
    imAccess: "opt-in",
    confirmTitle: "Delete Lark doc",
    confirmSummary: (args) => ({
      summary: `Move doc ${args.docToken} to trash. Recoverable for 30 days.`,
    }),
  })
)
