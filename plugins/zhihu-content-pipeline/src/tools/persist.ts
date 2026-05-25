/**
 * Plugin tools that let the writing crew persist into the plugin's Dexie
 * tables. Agents can't reach `ctx.dexie` (it isn't on the tool/step context),
 * so these `ctx.agent.registerTool` tools close over the `PluginDexieAPI`
 * handle captured in `activate()` and write through `createPipelineDb`.
 *
 * Exposed to the agent via the `cognia-plugin-tools` MCP bridge
 * (`lib/claude/build-options.ts:buildPluginToolsManifest`).
 */

import type { PluginDexieAPI, PluginTool } from "@/types/plugin"
import { PLUGIN_ID } from "../ids"
import { createPipelineDb } from "../db/tables"

/** Build the two persistence tools bound to a live Dexie handle. */
export function makePersistTools(dexie: PluginDexieAPI): PluginTool[] {
  const db = createPipelineDb(dexie)

  const saveResearch: PluginTool = {
    name: "zhihu_save_research",
    pluginId: PLUGIN_ID,
    definition: {
      name: "zhihu_save_research",
      description:
        "保存一条知乎调研笔记到流水线数据库（可引用的事实/数据/案例/来源）。供调研员使用。",
      parametersSchema: {
        type: "object",
        properties: {
          topicId: { type: "string", description: "关联的选题 id（可选）" },
          kind: {
            type: "string",
            description: "笔记类型：fact | data | case | source 等",
          },
          content: { type: "string", description: "笔记正文（提取出的事实/数据/案例）" },
          sourceUrl: { type: "string", description: "来源链接（可溯源）" },
        },
        required: ["kind", "content"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const row = await db.saveResearch({
        topicId: asString(args.topicId),
        kind: asString(args.kind) || "note",
        content: asString(args.content),
        sourceUrl: asString(args.sourceUrl),
      })
      return { ok: true, id: row.id }
    },
  }

  const saveDraft: PluginTool = {
    name: "zhihu_save_draft",
    pluginId: PLUGIN_ID,
    definition: {
      name: "zhihu_save_draft",
      description:
        "把一篇知乎回答终稿（Markdown + 配图）存为草稿到流水线数据库。供写手/润色师在终稿确认后使用。默认仅存草稿，不发布。",
      parametersSchema: {
        type: "object",
        properties: {
          topicId: { type: "string", description: "关联的选题 id（可选）" },
          title: { type: "string", description: "回答标题/选题" },
          markdownBody: { type: "string", description: "终稿正文（Markdown）" },
          images: {
            type: "array",
            items: { type: "string" },
            description: "配图文件路径或来源链接（可选）",
          },
        },
        required: ["title", "markdownBody"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const row = await db.saveDraft({
        topicId: asString(args.topicId),
        title: asString(args.title),
        markdownBody: asString(args.markdownBody),
        images: Array.isArray(args.images) ? args.images.map(asString).filter(Boolean) : [],
      })
      return { ok: true, id: row.id, status: row.status }
    },
  }

  return [saveResearch, saveDraft]
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v)
}
