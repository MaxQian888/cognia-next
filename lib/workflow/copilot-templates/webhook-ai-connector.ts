/**
 * Copilot template — Webhook → AI → Connector notification.
 *
 * trigger.webhook → ai.extract → ai.prompt → action.connector.send
 *
 * Listens on a configurable HTTP path, extracts fields from the inbound
 * payload, drafts a notification with AI, and dispatches it through a
 * connector. Desktop-only — relies on the Tauri webhook router.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"
import type { WorkflowCopilotTemplate, CopilotSlotValues } from "./types"

const NOW = 1_730_000_000_000

function buildGraph(slots: CopilotSlotValues): VisualWorkflow {
  const webhookPath = String(slots.webhookPath ?? "incoming")
  const adapterId = String(slots.adapterId ?? "telegram_main")
  const conversationKey = String(slots.conversationKey ?? "alerts")
  return {
    id: `wf_copilot_webhook_ai_connector_${NOW}`,
    schemaVersion: 1,
    name: `Webhook → AI → ${conversationKey}`,
    description: `Listen on /${webhookPath}, extract structured fields from the request body, draft a notification with AI, and forward to ${adapterId}/${conversationKey}.`,
    icon: "Webhook",
    tags: ["webhook", "ai", "connector", "copilot"],
    createdAt: NOW,
    updatedAt: NOW,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n_webhook",
        type: "trigger.webhook",
        typeVersion: 1,
        position: { x: 80, y: 200 },
        data: {
          label: "Inbound webhook",
          params: {
            path: webhookPath,
            method: "POST",
            responseStatus: 202,
          },
          authoredBy: "ai",
        },
      },
      {
        id: "n_extract",
        type: "ai.extract",
        typeVersion: 1,
        position: { x: 340, y: 200 },
        data: {
          label: "Extract fields",
          params: {
            input: "{{ $trigger.payload.body }}",
            hint: "Return JSON { title: string, severity: 'info' | 'warn' | 'error', summary: string } describing the inbound event.",
          },
          authoredBy: "ai",
        },
      },
      {
        id: "n_draft",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 620, y: 200 },
        data: {
          label: "Draft notification",
          params: {
            systemPrompt:
              "Write a one-paragraph notification in plain English. Lead with severity, then title, then summary. Keep it under 80 words.",
            userPrompt:
              "Severity: {{ $node['n_extract'].out.severity }}\nTitle: {{ $node['n_extract'].out.title }}\nSummary: {{ $node['n_extract'].out.summary }}",
            temperature: 0.2,
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
          label: "Send notification",
          params: {
            adapterId,
            conversationKey,
            content: "{{ $node['n_draft'].out.completion }}",
          },
          authoredBy: "ai",
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_webhook", target: "n_extract" },
      { id: "e2", source: "n_extract", target: "n_draft" },
      { id: "e3", source: "n_draft", target: "n_send" },
    ],
  }
}

export const webhookAiConnectorCopilotTemplate: WorkflowCopilotTemplate = {
  id: "webhook-ai-connector",
  label: { en: "Webhook → AI → Connector", "zh-CN": "Webhook → AI → 通知" },
  description: {
    en: "Listen for an inbound webhook, extract key fields with AI, draft a notification, and forward through a connector adapter. Desktop-only.",
    "zh-CN": "监听入站 webhook，调 AI 抽取字段并生成通知，再通过 connector 投递。仅桌面端。",
  },
  iconName: "Webhook",
  tags: ["webhook", "ai", "connector", "desktop-only"],
  slots: [
    {
      key: "webhookPath",
      type: "string",
      label: { en: "Webhook path", "zh-CN": "Webhook 路径" },
      placeholder: "incoming",
      defaultValue: "incoming",
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
      placeholder: "alerts",
      required: true,
    },
  ],
  build: buildGraph,
}
