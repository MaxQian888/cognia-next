/**
 * "知乎选题候选" front-stage workflow template.
 *
 * The automated front half of the pipeline (热点 → 选题候选). A clean DAG:
 *   trigger.cron (daily) → action.mcp.invokeTool (zget hot) → ai.prompt (cluster
 *   + score → candidate JSON) → save-topics (custom node → topics table).
 *
 * It deliberately ENDS at the topics table — the 选题 human gate happens in the
 * review panel, and the 调研→写作→配图→终稿 stages run interactively (in-workflow
 * HITL pause/resume is incomplete; see the design notes).
 *
 * The hot-list step runs `zget hot --format json` through the built-in
 * `action.system.terminal` node (real shell, desktop-only) rather than an MCP
 * tool — a built-in plugin can't ship a spawnable zget MCP wrapper. The user
 * fills provider/model/apiKey on the Rank node for a real ranking call (it
 * stubs without credentials).
 */

import { defineWorkflowTemplate } from "@cognia/plugin-sdk"
import type {
  PluginWorkflowTemplateDef,
  PluginWorkflowTemplateNode,
  PluginWorkflowTemplateEdge,
} from "@cognia/plugin-sdk"
import { nodeKind } from "../ids"
import { SAVE_TOPICS_KIND } from "../nodes/save-topics"

const SAVE_TOPICS_NODE_KIND = nodeKind(SAVE_TOPICS_KIND)

const RANK_SYSTEM_PROMPT =
  "你是知乎选题编辑。给你一份知乎热榜原始数据，请聚类去重、判断每个话题是否适合写知乎回答（有具体的人+具体信息、现有回答有空白），" +
  "为每个候选打 0-100 分并给一句升温/适配理由。只输出一个 JSON 数组，元素形如 " +
  '{ "title": string, "url": string, "reason": string, "score": number }，按 score 降序，最多 8 条。不要输出 JSON 以外的任何文字。'

const NODES: PluginWorkflowTemplateNode[] = [
  {
    id: "note",
    type: "annotation.note",
    typeVersion: 1,
    position: { x: 0, y: -130 },
    data: {
      label: "Setup",
      params: {
        text:
          "运行前：① 本机 `npm i -g zget-cli` 且 `zget login`（热榜步骤用终端节点跑 zget，桌面端 Tauri 限定）；" +
          "② 在「设置 → AI」里配好模型路由（Rank 节点用 routed 模式走应用已配置的 provider，无需在节点上填 key）。" +
          "每天 09:00 自动跑（终端节点为无人值守模式，不会弹确认框），也可在编辑器点 Run 手动跑。",
      },
    },
  },
  {
    id: "trigger",
    type: "trigger.cron",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: "每日 09:00", params: { cron: "0 9 * * *" } },
  },
  {
    id: "scan",
    type: "action.system.terminal",
    typeVersion: 1,
    position: { x: 240, y: 0 },
    data: {
      label: "知乎热榜",
      params: {
        command: "zget hot --format json",
        onFailure: "throw",
        // A cron-triggered run has nobody present to answer a consent prompt.
        // Without this the node takes the DOCK path (`terminal.ts`), which
        // calls `requestAgentTrust` and opens a tab — so the 09:00 run just
        // sat waiting on a dialog until it timed out and failed the workflow.
        unattended: true,
      },
    },
  },
  {
    id: "rank",
    type: "ai.prompt",
    typeVersion: 1,
    position: { x: 480, y: 0 },
    data: {
      label: "聚类打分",
      params: {
        // `routed` uses the app's configured provider routing. WITHOUT it the
        // node falls into `ai-prompt-v2`'s explicit branch, which needs
        // provider+model+apiKey ON THE NODE — the template has no place to put
        // them, so every run hit the "using stub echo" fallback, `save` failed
        // to parse the echo and swallowed it, and the daily cron wrote 0 rows
        // while reporting success.
        mode: "routed",
        systemPrompt: RANK_SYSTEM_PROMPT,
        // NOTE: no `.out` wrapper — the runtime stores a node's raw executor
        // output at `upstream[id]` (see lib/workflow/editor/expr-ref.ts).
        userPrompt: "知乎热榜原始数据如下，请产出候选选题 JSON：\n\n{{ $node['scan'].output }}",
      },
    },
  },
  {
    id: "save",
    type: SAVE_TOPICS_NODE_KIND,
    typeVersion: 1,
    position: { x: 720, y: 0 },
    data: {
      label: "存选题候选",
      params: { candidates: "{{ $node['rank'].completion }}", source: "zhihu-hot" },
    },
  },
]

const EDGES: PluginWorkflowTemplateEdge[] = [
  { id: "e_trigger_scan", source: "trigger", target: "scan" },
  { id: "e_scan_rank", source: "scan", target: "rank" },
  { id: "e_rank_save", source: "rank", target: "save" },
]

export const TOPIC_DISCOVERY_TEMPLATE = defineWorkflowTemplate({
  id: "zhihu-topic-discovery",
  name: "知乎选题候选（每日热点）",
  description:
    "每天抓知乎热榜 → 聚类打分 → 把候选选题写入流水线数据库，供审阅面板做选题确认。前段自动化，选题/写作走人工 + 团队对话。",
  category: "automation",
  icon: "Newspaper",
  complexity: "intermediate",
  nodes: NODES,
  edges: EDGES,
  requires: {
    pluginNodeKinds: [SAVE_TOPICS_NODE_KIND],
  },
}) satisfies PluginWorkflowTemplateDef
