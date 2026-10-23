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
    "Document token or URL. Obtain it from lark_doc_search, or resolve a wiki node via lark_wiki_read_node. Tokens need not have a fixed prefix."
  )

const revisionParam = z
  .number()
  .int()
  .min(-1)
  .optional()
  .describe("Document revision; -1 means latest.")
const fetchSchema = z
  .object({
    docToken: docTokenParam,
    mode: z.enum(["full", "outline", "range", "keyword", "section"]).optional(),
    format: z
      .enum(["simple", "with-ids", "full"])
      .optional()
      .describe("Output detail; with-ids/full retain block ids."),
    keyword: z.string().trim().min(1).optional().describe("Required for keyword mode."),
    sectionId: z.string().trim().min(1).optional().describe("Compatible alias for startBlockId."),
    startBlockId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Required for section; at least one bound is required for range."),
    endBlockId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Range end block id; -1 reads through the end."),
    contentFormat: z
      .enum(["xml", "markdown", "im-markdown"])
      .optional()
      .describe("Body encoding, independent of output detail."),
    revisionId: revisionParam,
  })
  .superRefine((args, ctx) => {
    const start = args.startBlockId ?? args.sectionId
    if (args.startBlockId && args.sectionId && args.startBlockId !== args.sectionId) {
      ctx.addIssue({
        code: "custom",
        path: ["startBlockId"],
        message: "startBlockId and sectionId must agree.",
      })
    }
    if (args.mode === "section" && !start) {
      ctx.addIssue({
        code: "custom",
        path: ["startBlockId"],
        message: "Section mode requires a start block.",
      })
    }
    if (args.mode === "range" && !start && !args.endBlockId) {
      ctx.addIssue({
        code: "custom",
        path: ["startBlockId"],
        message: "Range mode requires at least one bound.",
      })
    }
    if (args.mode === "keyword" && !args.keyword) {
      ctx.addIssue({
        code: "custom",
        path: ["keyword"],
        message: "Keyword mode requires a keyword.",
      })
    }
  })

const updateSchema = z
  .object({
    docToken: docTokenParam,
    operation: z.enum([
      "append",
      "overwrite",
      "block_replace",
      "block_insert_after",
      "block_delete",
      "str_replace",
      "block_move_after",
      "block_copy_insert_after",
    ]),
    payload: z
      .string()
      .optional()
      .describe(
        "Required for content edits; empty is allowed only for str_replace deletion. Not used for block deletion/move/copy."
      ),
    format: z
      .enum(["docx-xml", "xml", "markdown"])
      .optional()
      .describe("Body format; defaults to XML."),
    anchor: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Required existing text for str_replace, or target block id(s) for block operations."
      ),
    sourceBlockIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe("Required source block ids for block move/copy."),
    revisionId: revisionParam,
  })
  .superRefine((args, ctx) => {
    const noContent = ["block_delete", "block_move_after", "block_copy_insert_after"].includes(
      args.operation
    )
    if (
      !noContent &&
      (args.payload === undefined ||
        (args.operation !== "str_replace" && args.payload.length === 0))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: "This operation requires content (only str_replace may be empty).",
      })
    }
    if (
      (args.operation === "str_replace" || args.operation.startsWith("block_")) &&
      !args.anchor?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["anchor"],
        message: "This operation requires an anchor.",
      })
    }
    if (
      ["block_move_after", "block_copy_insert_after"].includes(args.operation) &&
      !args.sourceBlockIds?.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceBlockIds"],
        message: "Move/copy requires source block ids.",
      })
    }
  })

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
  execute?: BuiltInSkill<S>["execute"]
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
    execute:
      input.execute ??
      (async (args, ctx) =>
        runLarkCli({
          args: [
            ...input.subcommand,
            ...(input.buildArgs?.(args) ?? argsToFlags(args as Record<string, unknown>)),
          ],
          // Only high-risk CLI commands define --yes. Ordinary writes are
          // already approved by the dispatcher and reject that CLI flag.
          confirmed:
            input.mutation === "destructive" &&
            (ctx.hitlBypass === true || ctx.humanConfirmed === true),
          adapterId: larkAdapterIdFromCtx(ctx),
        })),
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
      en: "Full-text search across the user's Lark cloud-docs. Returns the tokens that lark_doc_fetch and lark_doc_update accept.",
      "zh-CN":
        "在用户的 Lark 云空间中全文搜索，返回可用于 lark_doc_fetch / lark_doc_update 的文档 token。",
    },
    schema: z.object({
      query: z.string().min(1).describe("Keywords to search doc titles/content for."),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results to return (1–20)."),
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
      en: "Read a Lark doc by token. Use mode=outline/keyword/section to locate parts of a large doc, and format=with-ids to get the block ids that targeted lark_doc_update ops need.",
      "zh-CN":
        "按 token 读取 Lark 文档内容。大文档可用 outline / keyword / section 模式定位局部；format=with-ids 返回 block id，供 lark_doc_update 定点编辑。",
    },
    schema: fetchSchema,
    subcommand: ["docs", "+fetch"],
    buildArgs: (args) =>
      argsToFlags({
        doc: args.docToken,
        scope: args.mode,
        detail: args.format,
        keyword: args.keyword,
        startBlockId: args.startBlockId ?? args.sectionId,
        endBlockId: args.endBlockId,
        docFormat: args.contentFormat,
        revisionId: args.revisionId,
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
      en: "Edit a Lark doc: append/overwrite, str_replace, block_replace/insert_after/delete/move_after/copy_insert_after. Choose XML or Markdown content and optionally a base revision.",
      "zh-CN":
        "编辑 Lark 文档：追加、覆盖、文本替换、块替换/插入/删除/移动/复制；支持 XML、Markdown 和基准版本。",
    },
    schema: updateSchema,
    subcommand: ["docs", "+update"],
    buildArgs: (args) =>
      argsToFlags({
        doc: args.docToken,
        command: args.operation,
        ...(!["block_delete", "block_move_after", "block_copy_insert_after"].includes(
          args.operation
        )
          ? { content: args.payload, docFormat: args.format === "markdown" ? "markdown" : "xml" }
          : {}),
        ...(args.operation === "str_replace"
          ? { pattern: args.anchor }
          : args.operation.startsWith("block_")
            ? { blockId: args.anchor }
            : {}),
        ...(["block_move_after", "block_copy_insert_after"].includes(args.operation)
          ? { srcBlockIds: args.sourceBlockIds?.join(",") }
          : {}),
        revisionId: args.revisionId,
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
        .trim()
        .min(1)
        .optional()
        .describe("Optional block id to insert the image after; omit to append at the end."),
    }),
    subcommand: ["docs", "+media-insert"],
    execute: async (args, ctx) => {
      const run = (argv: string[]) =>
        runLarkCli({
          args: argv,
          confirmed: false,
          adapterId: larkAdapterIdFromCtx(ctx),
        })
      const anchor = args.anchorBlockId
      if (anchor) {
        // Resolve the exact target before creating anything. A block id is
        // never a text selector, including when the target has duplicate text.
        await run([
          "docs",
          "+fetch",
          "--doc",
          args.docToken,
          "--scope",
          "range",
          "--start-block-id",
          anchor,
          "--end-block-id",
          anchor,
        ])
      }
      const inserted = await run([
        "docs",
        "+media-insert",
        "--doc",
        args.docToken,
        "--file",
        args.imagePath,
        "--type",
        "image",
      ])
      if (!anchor) return inserted
      const envelope = z.object({ data: z.unknown().optional() }).passthrough().safeParse(inserted)
      const body = envelope.success ? (envelope.data.data ?? envelope.data) : inserted
      const parsed = z.object({ block_id: z.string().min(1) }).safeParse(body)
      if (!parsed.success) {
        throw new Error(
          "Image uploaded, but the CLI response has no created block id; placement is unconfirmed. Inspect the document before retrying."
        )
      }
      const blockId = parsed.data.block_id
      try {
        const placement = await run([
          "docs",
          "+update",
          "--doc",
          args.docToken,
          "--command",
          "block_move_after",
          "--block-id",
          anchor,
          "--src-block-ids",
          blockId,
        ])
        return { upload: inserted, placement }
      } catch (error) {
        // Compensate only our new block; never delete or rewrite the anchor.
        try {
          await run([
            "docs",
            "+update",
            "--doc",
            args.docToken,
            "--command",
            "block_delete",
            "--block-id",
            blockId,
          ])
        } catch (cleanupError) {
          throw new Error(
            `Image placement failed (${String(error)}); created block ${blockId} remains or has unknown state: ${String(cleanupError)}. Inspect the document before retrying.`
          )
        }
        throw error
      }
    },
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
