/**
 * "知乎写作小组" agent-team template.
 *
 * The interactive back half of the pipeline (调研 → 写作 → 配图 → 终稿). Run as
 * an interactive team chat — that path goes through the sidecar/chat runner and
 * IS tool-enabled (unlike headless `action.team.run` / teammate dispatch, which
 * are text-only; see [[project-agent-execution-paths]]). The 终稿 human gate is
 * a natural chat turn, matching zhihu-answer-writer's four-step confirmation.
 *
 * Teammates carry their role playbook via the `skillIds` capability overlay
 * (plugin skill ids resolve through `resolveSkillsForCharacter`). `requires` is
 * validated (non-blocking) against the live overlay registries — pack id is the
 * raw registry id, skill ids are the self-namespaced ids, all contributed by
 * this same plugin.
 */

import { defineAgentTeamTemplate } from "@cognia/plugin-sdk"
import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"
import { ROLE_PACK_ID, packSkillId } from "../ids"

export const WRITING_CREW_TEMPLATE = defineAgentTeamTemplate({
  id: "zhihu-writing-crew",
  name: "知乎写作小组",
  description:
    "调研员、知乎写手、润色配图师协作完成一篇高赞回答：调研 → 写作 → 配图 → 终稿。在团队对话里跑，终稿处人工确认。",
  category: "research",
  icon: "Users",
  teammates: [
    {
      name: "调研员 Researcher",
      description: "围绕选定话题收集可引用的硬料并存为调研笔记。",
      systemPrompt:
        "你是知乎写作小组的调研员。按 deep-research 技能，用 Exa / fetch / zget 取料，必要时走 CloakBrowser，交叉验证关键数字，把可引用的事实/数据/案例用 zhihu_save_research 工具存进流水线库（带来源链接）。交付一份给写手可直接用的调研笔记。",
      capabilities: { skillIds: { add: [packSkillId("deep-research")] } },
      iconKey: "microscope",
      tags: ["research"],
    },
    {
      name: "知乎写手 Writer",
      description: "按四步确认流程把选题与调研写成有高赞气质的回答。",
      systemPrompt:
        "你是知乎高分回答写手。严格按 zhihu-answer-writer 技能的四步多轮确认（问题拆解+立场+钩子 → 结构大纲 → 正文初稿 → 配图方案），用 AskUserQuestion 在关键节点与用户对齐。守住硬约束：开头不铺垫、观点+案例、短段加粗分点、去 AI 味、人设真实。",
      capabilities: { skillIds: { add: [packSkillId("zhihu-answer-writer")] } },
      iconKey: "pen-line",
      tags: ["write"],
    },
    {
      name: "润色配图 Polisher",
      description: "去 AI 味润色，规划并产出配图，终稿确认后存草稿。",
      systemPrompt:
        "你是知乎写作小组的润色配图师。先按 de-ai-humanizer 修掉 AI 指纹并给改动理由，再按 zhihu-illustration 做配图方案与出图（gpt-image / mermaid / vega-lite / screenshot / 联网取图，绝不伪造真实数据图）。终稿经用户确认后用 zhihu_save_draft 存为草稿（默认不发布）。",
      capabilities: {
        skillIds: { add: [packSkillId("de-ai-humanizer"), packSkillId("zhihu-illustration")] },
      },
      iconKey: "palette",
      tags: ["polish", "illustration"],
    },
  ],
  taskTemplates: [
    {
      title: "调研选题",
      description: "围绕选定选题收集可引用的事实/数据/案例，存为调研笔记。",
      priority: "high",
      assignedToIndex: 0,
    },
    {
      title: "写正文",
      description: "按四步确认流程写出有高赞气质的回答初稿。",
      priority: "high",
      assignedToIndex: 1,
    },
    {
      title: "润色 + 配图 + 存草稿",
      description: "去 AI 味、规划并产出配图，终稿确认后存为草稿。",
      priority: "normal",
      assignedToIndex: 2,
    },
  ],
  requires: {
    characterPackIds: [ROLE_PACK_ID],
    skillIds: [
      packSkillId("deep-research"),
      packSkillId("zhihu-answer-writer"),
      packSkillId("de-ai-humanizer"),
      packSkillId("zhihu-illustration"),
    ],
  },
}) satisfies PluginAgentTeamTemplateDef
