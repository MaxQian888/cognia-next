/**
 * Workflow fixture factory — emits a canonical `WorkflowDraft` for every
 * E2E seed kind exposed via `window.__cogniaSeedWorkflow`. Kept in a
 * standalone module so the unit tests can validate the catalog without
 * mounting the React bridge component.
 *
 * Each fixture is a minimal-but-valid graph: the trigger that starts the
 * flow, the node under test, and (when the node needs an upstream input)
 * one feeder node. Specs that need richer wiring rebuild from these.
 */

import type { WorkflowDraft } from "@/lib/db/workflows"
import type { WorkflowNode, WorkflowEdge } from "@/types/workflow/visual"

export type SeededWorkflowKind =
  // Existing fixtures (kept for back-compat).
  | "manual-ai"
  | "branch"
  | "cycle"
  | "multi-step"
  // AI family
  | "ai-prompt"
  | "ai-classify"
  | "ai-extract"
  | "ai-embed"
  // Data family
  | "data-transform"
  | "data-code"
  | "data-template"
  // Flow family
  | "flow-branch"
  | "flow-switch"
  | "flow-split-join"
  | "flow-loop"
  | "flow-wait"
  | "flow-set"
  | "flow-subworkflow"
  // IO family
  | "io-http"
  | "io-webhook-respond"
  // Triggers (extra to manual)
  | "trigger-cron"
  | "trigger-webhook"
  | "trigger-chat"
  | "trigger-connector-inbound"
  | "trigger-github-webhook"
  | "trigger-goal-completed"
  // Character actions
  | "action-character-send"
  | "action-character-create"
  | "action-character-update"
  // Team actions
  | "action-team-run"
  | "action-team-create"
  | "action-team-update"
  // Skill actions
  | "action-skill-invoke"
  | "action-skill-upsert"
  // Twin actions (stubs)
  | "action-twin-rag"
  | "action-twin-ingest"
  // Connector actions
  | "action-connector-send"
  | "action-connector-draft"
  // MCP + Plugin (stubs)
  | "action-mcp-invoke"
  | "action-plugin-invoke"
  // GitHub actions
  | "action-github-open-pr"
  | "action-github-close-pr"
  | "action-github-merge-pr"
  | "action-github-review-pr"
  | "action-github-review-pr-inline"
  | "action-github-comment-pr"
  | "action-github-comment-issue"
  | "action-github-label-issue"
  | "action-github-close-issue"
  | "action-github-create-release"
  | "action-github-generate-changelog"
  | "action-github-push-tag"
  | "action-github-run-issue-loop"
  // Desktop actions
  | "action-desktop-screenshot"
  | "action-desktop-find-element"
  | "action-desktop-read-tree"
  | "action-desktop-click"
  | "action-desktop-type"
  | "action-desktop-keys"
  | "action-desktop-invoke-pattern"
  | "action-desktop-window-focus"
  | "action-desktop-window-close"
  | "action-desktop-window-resize"
  | "action-desktop-wait"
  // Annotations
  | "annotation-note"
  | "annotation-group"

const TRIGGER_MANUAL: WorkflowNode = {
  id: "n_trigger",
  type: "trigger.manual",
  typeVersion: 1,
  position: { x: 80, y: 120 },
  data: { label: "Manual", params: {} },
}

// Helper: build a draft with a manual trigger + one action node, plus a
// single edge connecting them.
function chain(
  name: string,
  actions: Array<{
    id: string
    type: string
    label: string
    params: Record<string, unknown>
    position?: { x: number; y: number }
  }>
): WorkflowDraft {
  const nodes: WorkflowNode[] = [
    TRIGGER_MANUAL,
    ...actions.map(
      (a, i): WorkflowNode => ({
        id: a.id,
        type: a.type as WorkflowNode["type"],
        typeVersion: 1,
        position: a.position ?? { x: 320 + i * 240, y: 120 },
        data: { label: a.label, params: a.params },
      })
    ),
  ]
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: `e_${i}`, source: nodes[i].id, target: nodes[i + 1].id })
  }
  return { name, nodes, edges }
}

const FIXTURES: Record<SeededWorkflowKind, () => WorkflowDraft> = {
  // ── Existing fixtures ─────────────────────────────────────────────────
  "manual-ai": () =>
    chain("E2E Manual → AI", [
      {
        id: "n_prompt",
        type: "ai.prompt",
        label: "Prompt",
        params: { model: "stub-model", userPrompt: "Hello", provider: "stub" },
      },
    ]),
  branch: () => ({
    name: "E2E Branch",
    nodes: [
      TRIGGER_MANUAL,
      {
        id: "n_branch",
        type: "flow.branch",
        typeVersion: 1,
        position: { x: 360, y: 120 },
        data: { label: "Branch", params: { condition: "true" } },
      },
      {
        id: "n_true",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 640, y: 40 },
        data: { label: "True path", params: { variable: "result", value: "yes" } },
      },
      {
        id: "n_false",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 640, y: 200 },
        data: { label: "False path", params: { variable: "result", value: "no" } },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_branch" },
      { id: "e2", source: "n_branch", sourceHandle: "true", target: "n_true" },
      { id: "e3", source: "n_branch", sourceHandle: "false", target: "n_false" },
    ],
  }),
  cycle: () => ({
    name: "E2E Cycle",
    nodes: [
      { ...TRIGGER_MANUAL, id: "n_a", data: { label: "A", params: {} } },
      {
        id: "n_b",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 360, y: 120 },
        data: { label: "B", params: { variable: "k", value: "v" } },
      },
    ],
    edges: [{ id: "e1", source: "n_a", target: "n_b" }],
  }),
  "multi-step": () => ({
    name: "E2E Multi-step",
    nodes: [
      TRIGGER_MANUAL,
      {
        id: "n_prompt",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 320, y: 120 },
        data: {
          label: "Prompt",
          params: { model: "stub-model", userPrompt: "Hello", provider: "stub" },
        },
      },
      {
        id: "n_transform",
        type: "data.transform",
        typeVersion: 1,
        position: { x: 560, y: 120 },
        data: { label: "Transform", params: { expression: "input.text.toUpperCase()" } },
      },
      {
        id: "n_branch",
        type: "flow.branch",
        typeVersion: 1,
        position: { x: 800, y: 120 },
        data: { label: "Decide", params: { condition: "true" } },
      },
      {
        id: "n_true",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 1040, y: 40 },
        data: { label: "OK", params: { variable: "status", value: "ok" } },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_prompt" },
      { id: "e2", source: "n_prompt", target: "n_transform" },
      { id: "e3", source: "n_transform", target: "n_branch" },
      { id: "e4", source: "n_branch", sourceHandle: "true", target: "n_true" },
    ],
  }),

  // ── AI ───────────────────────────────────────────────────────────────
  "ai-prompt": () =>
    chain("E2E AI Prompt", [
      {
        id: "n_prompt",
        type: "ai.prompt",
        label: "Prompt",
        params: {
          provider: "anthropic",
          model: "claude-3-haiku",
          apiKey: "test",
          userPrompt: "Say hi",
          temperature: 0,
        },
      },
    ]),
  "ai-classify": () =>
    chain("E2E AI Classify", [
      {
        id: "n_classify",
        type: "ai.classify",
        label: "Classify",
        params: {
          provider: "anthropic",
          model: "claude-3-haiku",
          apiKey: "test",
          text: "Order is late",
          categories: ["complaint", "praise"],
        },
      },
    ]),
  "ai-extract": () =>
    chain("E2E AI Extract", [
      {
        id: "n_extract",
        type: "ai.extract",
        label: "Extract",
        params: {
          provider: "anthropic",
          model: "claude-3-haiku",
          apiKey: "test",
          text: "Order #1234 for John",
          schemaJson: '{"orderId":"string","customer":"string"}',
        },
      },
    ]),
  "ai-embed": () =>
    chain("E2E AI Embed", [
      {
        id: "n_embed",
        type: "ai.embed",
        label: "Embed",
        params: { provider: "anthropic", model: "voyage-3", apiKey: "test", text: "vector me" },
      },
    ]),

  // ── Data ─────────────────────────────────────────────────────────────
  "data-transform": () =>
    chain("E2E Data Transform", [
      {
        id: "n_t",
        type: "data.transform",
        label: "Transform",
        params: { expression: "input.value * 2" },
      },
    ]),
  "data-code": () =>
    chain("E2E Data Code", [
      {
        id: "n_c",
        type: "data.code",
        label: "Code",
        params: { language: "javascript", code: "return { doubled: input.value * 2 }" },
      },
    ]),
  "data-template": () =>
    chain("E2E Data Template", [
      {
        id: "n_tpl",
        type: "data.template",
        label: "Template",
        params: { template: "Hello {{ input.name }}" },
      },
    ]),

  // ── Flow ─────────────────────────────────────────────────────────────
  "flow-branch": () =>
    chain("E2E Flow Branch", [
      { id: "n_br", type: "flow.branch", label: "Branch", params: { condition: "input.ok" } },
    ]),
  "flow-switch": () => ({
    name: "E2E Flow Switch",
    nodes: [
      TRIGGER_MANUAL,
      {
        id: "n_sw",
        type: "flow.switch",
        typeVersion: 1,
        position: { x: 320, y: 120 },
        data: {
          label: "Switch",
          params: {
            subject: "input.kind",
            cases: [
              { value: "alpha", label: "alpha" },
              { value: "beta", label: "beta" },
            ],
            defaultLabel: "default",
          },
        },
      },
      {
        id: "n_alpha",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 600, y: 40 },
        data: { label: "Alpha", params: { variable: "out", value: "A" } },
      },
      {
        id: "n_beta",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 600, y: 160 },
        data: { label: "Beta", params: { variable: "out", value: "B" } },
      },
      {
        id: "n_default",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 600, y: 280 },
        data: { label: "Default", params: { variable: "out", value: "D" } },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_sw" },
      { id: "e2", source: "n_sw", sourceHandle: "alpha", target: "n_alpha" },
      { id: "e3", source: "n_sw", sourceHandle: "beta", target: "n_beta" },
      { id: "e4", source: "n_sw", sourceHandle: "default", target: "n_default" },
    ],
  }),
  "flow-split-join": () => ({
    name: "E2E Flow Split-Join",
    nodes: [
      TRIGGER_MANUAL,
      {
        id: "n_split",
        type: "flow.split",
        typeVersion: 1,
        position: { x: 320, y: 120 },
        data: { label: "Split", params: { branches: 2 } },
      },
      {
        id: "n_a",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 560, y: 40 },
        data: { label: "A", params: { variable: "a", value: 1 } },
      },
      {
        id: "n_b",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 560, y: 200 },
        data: { label: "B", params: { variable: "b", value: 2 } },
      },
      {
        id: "n_join",
        type: "flow.join",
        typeVersion: 1,
        position: { x: 800, y: 120 },
        data: { label: "Join", params: { strategy: "all" } },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_split" },
      { id: "e2", source: "n_split", sourceHandle: "0", target: "n_a" },
      { id: "e3", source: "n_split", sourceHandle: "1", target: "n_b" },
      { id: "e4", source: "n_a", target: "n_join" },
      { id: "e5", source: "n_b", target: "n_join" },
    ],
  }),
  "flow-loop": () =>
    chain("E2E Flow Loop", [
      {
        id: "n_loop",
        type: "flow.loop",
        label: "Loop",
        params: { items: "[1,2,3]", maxIterations: 3 },
      },
      {
        id: "n_body",
        type: "flow.set",
        label: "Iter",
        params: { variable: "iter", value: "{{ item }}" },
      },
    ]),
  "flow-wait": () =>
    chain("E2E Flow Wait", [
      { id: "n_wait", type: "flow.wait", label: "Wait", params: { durationMs: 100 } },
    ]),
  "flow-set": () =>
    chain("E2E Flow Set", [
      { id: "n_set", type: "flow.set", label: "Set", params: { variable: "x", value: 42 } },
    ]),
  "flow-subworkflow": () =>
    chain("E2E Flow Subworkflow", [
      {
        id: "n_sub",
        type: "flow.subworkflow",
        label: "Sub",
        params: { workflowId: "wf_child_placeholder" },
      },
    ]),

  // ── IO ───────────────────────────────────────────────────────────────
  "io-http": () =>
    chain("E2E IO HTTP", [
      {
        id: "n_http",
        type: "io.http",
        label: "HTTP",
        params: { method: "GET", url: "https://example.test/data" },
      },
    ]),
  "io-webhook-respond": () =>
    chain("E2E IO Webhook Respond", [
      {
        id: "n_resp",
        type: "io.webhook.respond",
        label: "Respond",
        params: { statusCode: 200, body: '{"ok":true}' },
      },
    ]),

  // ── Triggers ─────────────────────────────────────────────────────────
  "trigger-cron": () => ({
    name: "E2E Cron Trigger",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.cron",
        typeVersion: 1,
        position: { x: 80, y: 120 },
        data: { label: "Cron", params: { schedule: "0 9 * * *", timezone: "UTC" } },
      },
    ],
    edges: [],
  }),
  "trigger-webhook": () => ({
    name: "E2E Webhook Trigger",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.webhook",
        typeVersion: 1,
        position: { x: 80, y: 120 },
        data: { label: "Webhook", params: { path: "/hooks/test", method: "POST", secret: "shh" } },
      },
    ],
    edges: [],
  }),
  "trigger-chat": () => ({
    name: "E2E Chat Trigger",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.chat.message",
        typeVersion: 1,
        position: { x: 80, y: 120 },
        data: { label: "Chat", params: { conversationKey: "", filterPattern: "" } },
      },
    ],
    edges: [],
  }),
  "trigger-connector-inbound": () => ({
    name: "E2E Connector Trigger",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.connector.inbound",
        typeVersion: 1,
        position: { x: 80, y: 120 },
        data: { label: "Connector Inbound", params: { adapterId: "lark", filterPattern: ".*" } },
      },
    ],
    edges: [],
  }),
  "trigger-github-webhook": () => ({
    name: "E2E GitHub Webhook Trigger",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 120 },
        data: {
          label: "GitHub Webhook",
          params: { repo: "owner/repo", events: ["pull_request"], secret: "shh" },
        },
      },
    ],
    edges: [],
  }),
  "trigger-goal-completed": () => ({
    name: "E2E Goal Completed Trigger",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.goal.completed",
        typeVersion: 1,
        position: { x: 80, y: 120 },
        data: { label: "Goal Completed", params: { status: "completed" } },
      },
    ],
    edges: [],
  }),

  // ── Character actions ────────────────────────────────────────────────
  "action-character-send": () =>
    chain("E2E Character Send", [
      {
        id: "n_send",
        type: "action.character.send",
        label: "Send",
        params: { characterId: "c_test", content: "Hi" },
      },
    ]),
  "action-character-create": () =>
    chain("E2E Character Create", [
      {
        id: "n_create",
        type: "action.character.create",
        label: "Create",
        params: { name: "E2E Char", role: "demo", systemPrompt: "Be helpful" },
      },
    ]),
  "action-character-update": () =>
    chain("E2E Character Update", [
      {
        id: "n_upd",
        type: "action.character.update",
        label: "Update",
        params: { characterId: "c_test", patch: { name: "Renamed" } },
      },
    ]),

  // ── Team actions ─────────────────────────────────────────────────────
  "action-team-run": () =>
    chain("E2E Team Run", [
      {
        id: "n_run",
        type: "action.team.run",
        label: "Run",
        params: { teamId: "t_test", prompt: "Run" },
      },
    ]),
  "action-team-create": () =>
    chain("E2E Team Create", [
      {
        id: "n_tc",
        type: "action.team.create",
        label: "Create",
        params: { name: "E2E Team", description: "demo" },
      },
    ]),
  "action-team-update": () =>
    chain("E2E Team Update", [
      {
        id: "n_tu",
        type: "action.team.update",
        label: "Update",
        params: { teamId: "t_test", patch: { name: "Renamed" } },
      },
    ]),

  // ── Skill actions ────────────────────────────────────────────────────
  "action-skill-invoke": () =>
    chain("E2E Skill Invoke", [
      {
        id: "n_si",
        type: "action.skill.invoke",
        label: "Invoke",
        params: { skillId: "s_test", input: { q: "hello" } },
      },
    ]),
  "action-skill-upsert": () =>
    chain("E2E Skill Upsert", [
      {
        id: "n_su",
        type: "action.skill.upsert",
        label: "Upsert",
        params: { name: "E2E Skill", trigger: "manual", body: "do thing" },
      },
    ]),

  // ── Twin actions (stubs) ─────────────────────────────────────────────
  "action-twin-rag": () =>
    chain("E2E Twin RAG", [
      {
        id: "n_rag",
        type: "action.twin.rag",
        label: "RAG",
        params: { twinId: "tw_test", query: "what is x" },
      },
    ]),
  "action-twin-ingest": () =>
    chain("E2E Twin Ingest", [
      {
        id: "n_ing",
        type: "action.twin.ingest",
        label: "Ingest",
        params: { twinId: "tw_test", sourceUrl: "https://example.test/doc" },
      },
    ]),

  // ── Connector actions ────────────────────────────────────────────────
  "action-connector-send": () =>
    chain("E2E Connector Send", [
      {
        id: "n_cs",
        type: "action.connector.send",
        label: "Send",
        params: { adapterId: "lark", conversationKey: "chat-1", content: "hello" },
      },
    ]),
  "action-connector-draft": () =>
    chain("E2E Connector Draft", [
      {
        id: "n_cd",
        type: "action.connector.draft",
        label: "Draft",
        params: {
          adapterId: "lark",
          conversationKey: "chat-1",
          sessionId: "sess-1",
          content: "draft",
        },
      },
    ]),

  // ── MCP + Plugin (stubs) ────────────────────────────────────────────
  "action-mcp-invoke": () =>
    chain("E2E MCP Invoke", [
      {
        id: "n_mcp",
        type: "action.mcp.invokeTool",
        label: "MCP",
        params: { serverId: "mcp_test", tool: "say_hello", args: {} },
      },
    ]),
  "action-plugin-invoke": () =>
    chain("E2E Plugin Invoke", [
      {
        id: "n_pi",
        type: "action.plugin.invoke",
        label: "Plugin",
        params: { pluginId: "p_test", capability: "echo", args: { text: "hi" } },
      },
    ]),

  // ── GitHub actions ───────────────────────────────────────────────────
  "action-github-open-pr": () =>
    chain("E2E GH OpenPR", [
      {
        id: "n_pr",
        type: "action.github.openPr",
        label: "Open PR",
        params: { repo: "owner/repo", title: "T", body: "B", head: "feat", base: "main" },
      },
    ]),
  "action-github-close-pr": () =>
    chain("E2E GH ClosePR", [
      {
        id: "n_cl",
        type: "action.github.closePr",
        label: "Close PR",
        params: { repo: "owner/repo", number: 1 },
      },
    ]),
  "action-github-merge-pr": () =>
    chain("E2E GH MergePR", [
      {
        id: "n_mg",
        type: "action.github.mergePr",
        label: "Merge PR",
        params: { repo: "owner/repo", number: 1, mergeMethod: "squash" },
      },
    ]),
  "action-github-review-pr": () =>
    chain("E2E GH ReviewPR", [
      {
        id: "n_rv",
        type: "action.github.reviewPr",
        label: "Review",
        params: { repo: "owner/repo", number: 1, event: "COMMENT", body: "lgtm" },
      },
    ]),
  "action-github-review-pr-inline": () =>
    chain("E2E GH ReviewInline", [
      {
        id: "n_rvi",
        type: "action.github.reviewPrInline",
        label: "Inline",
        params: {
          repo: "owner/repo",
          number: 1,
          comments: [{ path: "a.ts", line: 1, body: "nit" }],
        },
      },
    ]),
  "action-github-comment-pr": () =>
    chain("E2E GH CommentPR", [
      {
        id: "n_cpr",
        type: "action.github.commentPr",
        label: "Comment",
        params: { repo: "owner/repo", number: 1, body: "note" },
      },
    ]),
  "action-github-comment-issue": () =>
    chain("E2E GH CommentIssue", [
      {
        id: "n_ci",
        type: "action.github.commentIssue",
        label: "Comment Issue",
        params: { repo: "owner/repo", number: 1, body: "note" },
      },
    ]),
  "action-github-label-issue": () =>
    chain("E2E GH LabelIssue", [
      {
        id: "n_lab",
        type: "action.github.labelIssue",
        label: "Label",
        params: { repo: "owner/repo", number: 1, labels: ["bug"] },
      },
    ]),
  "action-github-close-issue": () =>
    chain("E2E GH CloseIssue", [
      {
        id: "n_clo",
        type: "action.github.closeIssue",
        label: "Close",
        params: { repo: "owner/repo", number: 1 },
      },
    ]),
  "action-github-create-release": () =>
    chain("E2E GH CreateRelease", [
      {
        id: "n_rel",
        type: "action.github.createRelease",
        label: "Release",
        params: { repo: "owner/repo", tagName: "v1.0.0", name: "v1.0.0", body: "notes" },
      },
    ]),
  "action-github-generate-changelog": () =>
    chain("E2E GH GenerateChangelog", [
      {
        id: "n_chg",
        type: "action.github.generateChangelog",
        label: "Changelog",
        params: { repo: "owner/repo", tagName: "v1.0.0", previousTag: "v0.9.0" },
      },
    ]),
  "action-github-push-tag": () =>
    chain("E2E GH PushTag", [
      {
        id: "n_tag",
        type: "action.github.pushTag",
        label: "Push Tag",
        params: { repo: "owner/repo", tag: "v1.0.0", sha: "abcd" },
      },
    ]),
  "action-github-run-issue-loop": () =>
    chain("E2E GH IssueLoop", [
      {
        id: "n_il",
        type: "action.github.runIssueLoop",
        label: "Issue Loop",
        params: { repo: "owner/repo", number: 1, maxIterations: 1 },
      },
    ]),

  // ── Desktop actions ──────────────────────────────────────────────────
  "action-desktop-screenshot": () =>
    chain("E2E Desktop Screenshot", [
      {
        id: "n_ds",
        type: "action.desktop.screenshot",
        label: "Screenshot",
        params: { region: "primary" },
      },
    ]),
  "action-desktop-find-element": () =>
    chain("E2E Desktop FindElement", [
      {
        id: "n_fe",
        type: "action.desktop.findElement",
        label: "Find",
        params: { strategy: "automationId", value: "btnOk" },
      },
    ]),
  "action-desktop-read-tree": () =>
    chain("E2E Desktop ReadTree", [
      {
        id: "n_rt",
        type: "action.desktop.readTree",
        label: "Tree",
        params: { rootHandle: "{{ window.handle }}", maxDepth: 3 },
      },
    ]),
  "action-desktop-click": () =>
    chain("E2E Desktop Click", [
      {
        id: "n_dc",
        type: "action.desktop.click",
        label: "Click",
        params: { elementHandle: "{{ found.handle }}", button: "left" },
      },
    ]),
  "action-desktop-type": () =>
    chain("E2E Desktop Type", [
      {
        id: "n_dt",
        type: "action.desktop.type",
        label: "Type",
        params: { elementHandle: "{{ found.handle }}", text: "hello" },
      },
    ]),
  "action-desktop-keys": () =>
    chain("E2E Desktop Keys", [
      { id: "n_dk", type: "action.desktop.keys", label: "Keys", params: { sequence: "ctrl+c" } },
    ]),
  "action-desktop-invoke-pattern": () =>
    chain("E2E Desktop InvokePattern", [
      {
        id: "n_ip",
        type: "action.desktop.invokePattern",
        label: "Invoke",
        params: { elementHandle: "{{ found.handle }}", pattern: "Invoke" },
      },
    ]),
  "action-desktop-window-focus": () =>
    chain("E2E Desktop WindowFocus", [
      {
        id: "n_wf",
        type: "action.desktop.windowFocus",
        label: "Focus",
        params: { windowTitle: "Notepad" },
      },
    ]),
  "action-desktop-window-close": () =>
    chain("E2E Desktop WindowClose", [
      {
        id: "n_wc",
        type: "action.desktop.windowClose",
        label: "Close",
        params: { windowTitle: "Notepad" },
      },
    ]),
  "action-desktop-window-resize": () =>
    chain("E2E Desktop WindowResize", [
      {
        id: "n_wr",
        type: "action.desktop.windowResize",
        label: "Resize",
        params: { windowTitle: "Notepad", width: 800, height: 600 },
      },
    ]),
  "action-desktop-wait": () =>
    chain("E2E Desktop Wait", [
      {
        id: "n_dw",
        type: "action.desktop.wait",
        label: "Wait",
        params: { conditionExpr: "true", timeoutMs: 1000 },
      },
    ]),

  // ── Annotations ──────────────────────────────────────────────────────
  "annotation-note": () => ({
    name: "E2E Annotation Note",
    nodes: [
      TRIGGER_MANUAL,
      {
        id: "n_note",
        type: "annotation.note",
        typeVersion: 1,
        position: { x: 320, y: 40 },
        data: { label: "Note", params: { text: "A reminder", color: "yellow" } },
      },
    ],
    edges: [],
  }),
  "annotation-group": () => ({
    name: "E2E Annotation Group",
    nodes: [
      TRIGGER_MANUAL,
      {
        id: "n_group",
        type: "annotation.group",
        typeVersion: 1,
        position: { x: 320, y: 40 },
        data: {
          label: "Group",
          params: { title: "Stage A", color: "blue", width: 320, height: 200 },
        },
      },
    ],
    edges: [],
  }),
}

export const SEEDED_WORKFLOW_KINDS = Object.keys(FIXTURES) as SeededWorkflowKind[]

/** Build the canonical fixture draft for the given seed kind. */
export function buildWorkflowFixture(kind: SeededWorkflowKind): WorkflowDraft {
  const factory = FIXTURES[kind]
  if (!factory) throw new Error(`Unknown seeded workflow kind: ${kind}`)
  return factory()
}
