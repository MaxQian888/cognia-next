/**
 * Copilot template — GitHub Issue → AI extract → open draft PR pipeline.
 *
 * Slot-driven scaffolding meant to be merged into an open editor via the
 * proposal flow. NOT the same as `lib/workflow/definition/templates/
 * github-issue-to-pr.ts` (which is the longer, seed-only starter graph
 * driven by trigger-payload expressions and is surfaced in Settings →
 * Workflows → Templates). This version asks the user for repo / label /
 * base branch up front so the resulting graph is immediately runnable
 * without rummaging through the inspector.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"
import type { WorkflowCopilotTemplate, CopilotSlotValues } from "./types"

const NOW = 1_730_000_000_000

function buildGraph(slots: CopilotSlotValues): VisualWorkflow {
  const repoFullName = String(slots.repoFullName ?? "owner/repo")
  const labelName = String(slots.labelName ?? "auto-fix")
  const baseBranch = String(slots.baseBranch ?? "main")
  const webhookPath = String(slots.webhookPath ?? "github")
  return {
    id: `wf_copilot_github_pr_${NOW}`,
    schemaVersion: 1,
    name: `GitHub PR pipeline — ${repoFullName}`,
    description: `Listen for issues labeled "${labelName}" on ${repoFullName}, extract requirements, and open a draft PR against ${baseBranch}.`,
    icon: "GitMerge",
    tags: ["github", "ai", "copilot"],
    createdAt: NOW,
    updatedAt: NOW,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 200 },
        data: {
          label: "Issue labeled",
          params: {
            path: webhookPath,
            method: "POST",
            responseStatus: 202,
            events: ["issues.labeled"],
            filter: `{{ $trigger.payload.body.label.name === '${labelName}' }}`,
          },
          authoredBy: "ai",
        },
      },
      {
        id: "n_extract",
        type: "ai.extract",
        typeVersion: 1,
        position: { x: 360, y: 200 },
        data: {
          label: "Parse issue",
          params: {
            input:
              "Title: {{ $trigger.payload.body.issue.title }}\n\nBody:\n{{ $trigger.payload.body.issue.body }}",
            hint: "Return JSON { summary: string, acceptanceCriteria: string[] } describing the engineering work the issue asks for.",
          },
          authoredBy: "ai",
        },
      },
      {
        id: "n_open_pr",
        type: "action.github.openPr",
        typeVersion: 1,
        position: { x: 640, y: 200 },
        data: {
          label: "Open draft PR",
          params: {
            repoFullName,
            head: "auto-fix/{{ $trigger.payload.body.issue.number }}",
            base: baseBranch,
            title: "[auto-fix] {{ $node['n_extract'].out.summary }}",
            body: "Closes #{{ $trigger.payload.body.issue.number }}\n\n## Acceptance criteria\n{{ $node['n_extract'].out.acceptanceCriteria }}",
            draft: true,
          },
          authoredBy: "ai",
        },
      },
      {
        id: "n_comment",
        type: "action.github.commentPr",
        typeVersion: 1,
        position: { x: 920, y: 200 },
        data: {
          label: "Notify author",
          params: {
            repoFullName,
            prNumber: "{{ $node['n_open_pr'].out.number }}",
            body: "Draft PR opened automatically from issue #{{ $trigger.payload.body.issue.number }}. A maintainer will review shortly.",
          },
          authoredBy: "ai",
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_extract" },
      { id: "e2", source: "n_extract", target: "n_open_pr" },
      { id: "e3", source: "n_open_pr", target: "n_comment" },
    ],
  }
}

export const githubPrCopilotTemplate: WorkflowCopilotTemplate = {
  id: "github-pr",
  label: { en: "GitHub PR pipeline", "zh-CN": "GitHub PR 流水线" },
  description: {
    en: "Trigger on issues labeled with a tag of your choice, extract acceptance criteria with AI, and open a draft PR against the configured base branch.",
    "zh-CN": "监听指定标签的 issue，调用 AI 提取验收条件，并在指定分支上自动开一个 draft PR。",
  },
  iconName: "GitMerge",
  tags: ["github", "ai"],
  slots: [
    {
      key: "repoFullName",
      type: "string",
      label: { en: "Repository (owner/name)", "zh-CN": "仓库（owner/name）" },
      placeholder: "acme/widgets",
      required: true,
    },
    {
      key: "labelName",
      type: "string",
      label: { en: "Trigger label", "zh-CN": "触发标签" },
      placeholder: "auto-fix",
      defaultValue: "auto-fix",
    },
    {
      key: "baseBranch",
      type: "string",
      label: { en: "Base branch", "zh-CN": "基础分支" },
      placeholder: "main",
      defaultValue: "main",
    },
    {
      key: "webhookPath",
      type: "string",
      label: { en: "Webhook path", "zh-CN": "Webhook 路径" },
      placeholder: "github",
      defaultValue: "github",
    },
  ],
  build: buildGraph,
}
