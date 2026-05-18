/**
 * Copilot template — Cron report.
 *
 * trigger.cron → io.http → ai.prompt → action.connector.send
 *
 * Pulls data from a URL on a schedule, asks the AI to summarize it, and
 * dispatches the result through a configured connector adapter (Telegram,
 * Slack, Lark, Discord, OneBot). Slot-driven so the agent / Templates tab
 * can scaffold a working pipeline without follow-up inspector edits.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"
import type { WorkflowCopilotTemplate, CopilotSlotValues } from "./types"

const NOW = 1_730_000_000_000

function buildGraph(slots: CopilotSlotValues): VisualWorkflow {
  const cronExpression = String(slots.cronExpression ?? "0 9 * * 1-5")
  const sourceUrl = String(
    slots.sourceUrl ?? "https://hacker-news.firebaseio.com/v0/topstories.json"
  )
  const adapterId = String(slots.adapterId ?? "telegram_main")
  const conversationKey = String(slots.conversationKey ?? "ops")
  return {
    id: `wf_copilot_cron_report_${NOW}`,
    schemaVersion: 1,
    name: `Scheduled report — ${conversationKey}`,
    description: `Run on cron "${cronExpression}", fetch ${sourceUrl}, summarize with AI, and forward to ${adapterId}/${conversationKey}.`,
    icon: "Clock",
    tags: ["cron", "ai", "connector", "copilot"],
    createdAt: NOW,
    updatedAt: NOW,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n_cron",
        type: "trigger.cron",
        typeVersion: 1,
        position: { x: 80, y: 200 },
        data: {
          label: "Scheduled tick",
          params: { cron: cronExpression },
          authoredBy: "ai",
        },
      },
      {
        id: "n_fetch",
        type: "io.http",
        typeVersion: 1,
        position: { x: 340, y: 200 },
        data: {
          label: "Fetch source",
          params: {
            method: "GET",
            url: sourceUrl,
            timeoutMs: 10_000,
          },
          authoredBy: "ai",
        },
      },
      {
        id: "n_summary",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 620, y: 200 },
        data: {
          label: "Summarize",
          params: {
            systemPrompt:
              "Produce a 5-bullet morning digest from the user's payload. Lead with the highest-impact item; tag each bullet with a one-word topic.",
            userPrompt: "{{ $node['n_fetch'].out.body }}",
            temperature: 0.3,
          },
          authoredBy: "ai",
        },
      },
      {
        id: "n_send",
        type: "action.connector.send",
        typeVersion: 1,
        position: { x: 900, y: 200 },
        data: {
          label: "Send digest",
          params: {
            adapterId,
            conversationKey,
            content: "{{ $node['n_summary'].out.completion }}",
          },
          authoredBy: "ai",
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_cron", target: "n_fetch" },
      { id: "e2", source: "n_fetch", target: "n_summary" },
      { id: "e3", source: "n_summary", target: "n_send" },
    ],
  }
}

export const cronReportCopilotTemplate: WorkflowCopilotTemplate = {
  id: "cron-report",
  label: { en: "Scheduled report", "zh-CN": "定时报告" },
  description: {
    en: "Run on a cron schedule, fetch data from an HTTP source, summarize with AI, and dispatch the digest through a connector adapter.",
    "zh-CN": "按 cron 周期触发，拉取 HTTP 数据源，调 AI 总结后通过指定 connector 投递。",
  },
  iconName: "Clock",
  tags: ["cron", "ai", "connector"],
  slots: [
    {
      key: "cronExpression",
      type: "string",
      label: { en: "Cron expression", "zh-CN": "Cron 表达式" },
      placeholder: "0 9 * * 1-5",
      defaultValue: "0 9 * * 1-5",
      required: true,
    },
    {
      key: "sourceUrl",
      type: "string",
      label: { en: "Source URL", "zh-CN": "数据源 URL" },
      placeholder: "https://example.com/api/feed",
      required: true,
    },
    {
      key: "adapterId",
      type: "string",
      label: { en: "Connector adapter id", "zh-CN": "Connector 适配器 ID" },
      placeholder: "telegram_main",
      required: true,
    },
    {
      key: "conversationKey",
      type: "string",
      label: { en: "Conversation key", "zh-CN": "会话标识" },
      placeholder: "ops",
      required: true,
    },
  ],
  build: buildGraph,
}
