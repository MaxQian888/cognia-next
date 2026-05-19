/**
 * Lark Wiki skill family (ADR-0026).
 *
 *   - search_nodes   read
 *   - read_node      read
 *   - create_node    write
 *   - move_node      write
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillMutation } from "../types"
import type { BuiltInSkillImAccess } from "../types"
import { argsToFlags, buildConfirmSurface, runLarkCli } from "./_helpers"

const FAMILY = "lark.wiki"
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
    id: "lark.wiki.search_nodes",
    mcpToolName: "lark_wiki_search_nodes",
    label: { en: "Search wiki", "zh-CN": "搜索知识库" },
    description: {
      en: "Search Lark wiki nodes (pages and shortcuts) by keyword.",
      "zh-CN": "按关键词搜索 Lark 知识库节点。",
    },
    schema: z.object({
      query: z.string().min(1),
      spaceId: z.string().optional(),
    }),
    subcommand: ["wiki", "+search-nodes"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.wiki.read_node",
    mcpToolName: "lark_wiki_read_node",
    label: { en: "Read wiki node", "zh-CN": "读取知识库节点" },
    description: {
      en: "Fetch a Lark wiki node's content (resolves to the underlying docx token).",
      "zh-CN": "读取 Lark 知识库节点内容（解析至底层文档）。",
    },
    schema: z.object({
      spaceId: z.string().min(1),
      nodeToken: z.string().min(1),
    }),
    subcommand: ["wiki", "+read-node"],
    mutation: "read",
    imAccess: "always",
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.wiki.create_node",
    mcpToolName: "lark_wiki_create_node",
    label: { en: "Create wiki node", "zh-CN": "新建知识库节点" },
    description: {
      en: "Create a new node (docx) inside a Lark wiki space, optionally under a parent.",
      "zh-CN": "在 Lark 知识空间中新建节点（默认为 docx），可指定父节点。",
    },
    schema: z.object({
      spaceId: z.string().min(1),
      title: z.string().min(1),
      parentNodeToken: z.string().optional(),
      objType: z.enum(["docx", "sheet", "bitable"]).optional(),
    }),
    subcommand: ["wiki", "+create-node"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Create wiki node",
    confirmSummary: (args) => ({
      summary: `Create wiki node "${args.title}" in space ${args.spaceId}.`,
      details: args.parentNodeToken
        ? [{ label: "Parent", value: args.parentNodeToken }]
        : undefined,
    }),
  })
)

registerBuiltInSkill(
  mk({
    id: "lark.wiki.move_node",
    mcpToolName: "lark_wiki_move_node",
    label: { en: "Move wiki node", "zh-CN": "移动知识库节点" },
    description: {
      en: "Move a wiki node under a different parent within the same space.",
      "zh-CN": "在同一知识空间内将节点移动到另一个父节点下。",
    },
    schema: z.object({
      spaceId: z.string().min(1),
      nodeToken: z.string().min(1),
      newParentNodeToken: z.string().min(1),
    }),
    subcommand: ["wiki", "+move-node"],
    mutation: "write",
    imAccess: "always",
    confirmTitle: "Move wiki node",
    confirmSummary: (args) => ({
      summary: `Move node ${args.nodeToken} under ${args.newParentNodeToken}.`,
    }),
  })
)
