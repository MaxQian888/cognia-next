/**
 * Built-in workflow templates — the bundled gallery shown in Settings →
 * Workflows → Templates. Each template is the starter graph users can clone
 * via "Use template" to get a working pipeline without authoring from
 * scratch.
 *
 * Every template is composed entirely from executors that are registered
 * (see `lib/workflow/nodes/built-ins.ts`) so the user can run them
 * immediately. Templates that depend on Phase 6+ executors (character.send,
 * team.run, twin.rag, connector.send) ship later as those executors land.
 */

import { seedBuiltInWorkflows } from "@/lib/db/workflows"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000 // Stable timestamp so re-seeds don't change row hashes.

function template(
  partial: Pick<VisualWorkflow, "id" | "name" | "description" | "icon" | "tags" | "nodes" | "edges">
): VisualWorkflow {
  return {
    id: partial.id,
    schemaVersion: 1,
    name: partial.name,
    description: partial.description,
    icon: partial.icon,
    tags: partial.tags ?? [],
    isTemplate: true,
    isBuiltIn: true,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: partial.nodes,
    edges: partial.edges,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

function helloWorldTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_hello_world",
    name: "Hello world",
    description:
      "The simplest possible workflow — manual trigger fans into a single AI prompt and stores the result. Run it to confirm the editor and runtime are wired up correctly.",
    icon: "Sparkles",
    tags: ["starter", "ai"],
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 80, y: 120 },
        data: { label: "Click run", params: {} },
      },
      {
        id: "n_prompt",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 380, y: 120 },
        data: {
          label: "Greet the user",
          params: {
            systemPrompt: "You are a friendly assistant. Greet the user in two sentences.",
            userPrompt: "Hello!",
            temperature: 0.7,
          },
        },
      },
      {
        id: "n_save",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 700, y: 120 },
        data: {
          label: "Remember greeting",
          params: {
            variable: "lastGreeting",
            value: "{{ $node['n_prompt'].out.completion }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_prompt" },
      { id: "e2", source: "n_prompt", target: "n_save" },
    ],
  })
}

function httpDataPipelineTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_http_pipeline",
    name: "HTTP → transform → summarize",
    description:
      "Fetches a JSON list from an HTTP endpoint, maps the rows down to one field, and sends the result to an AI summarizer. Use as a scaffold for any 'pull external data, summarize it' workflow.",
    icon: "Globe",
    tags: ["http", "data", "ai", "starter"],
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 60, y: 140 },
        data: { label: "Run", params: {} },
      },
      {
        id: "n_fetch",
        type: "io.http",
        typeVersion: 1,
        position: { x: 320, y: 140 },
        data: {
          label: "Fetch JSON",
          params: {
            url: "https://jsonplaceholder.typicode.com/posts",
            method: "GET",
            followRedirects: true,
          },
        },
      },
      {
        id: "n_titles",
        type: "data.transform",
        typeVersion: 1,
        position: { x: 600, y: 140 },
        data: {
          label: "Pluck titles",
          params: {
            operation: "map",
            expression: "{{ $node['$item'].title }}",
          },
        },
      },
      {
        id: "n_summary",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 880, y: 140 },
        data: {
          label: "Summarize",
          params: {
            systemPrompt:
              "Summarize the user's list of headlines in 3 bullet points covering the dominant themes.",
            userPrompt: "Headlines:\n{{ $node['n_titles'].out }}",
            temperature: 0.3,
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_fetch" },
      { id: "e2", source: "n_fetch", target: "n_titles" },
      { id: "e3", source: "n_titles", target: "n_summary" },
    ],
  })
}

function conditionalReplyTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_conditional_reply",
    name: "Classify then branch",
    description:
      "Asks the AI to classify the trigger payload, then routes to one of two replies based on the result. Replace the AI step with action.character.send / action.connector.send once those executors are available.",
    icon: "GitBranch",
    tags: ["branch", "ai", "starter"],
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 40, y: 200 },
        data: { label: "Run with payload", params: {} },
      },
      {
        id: "n_classify",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 320, y: 200 },
        data: {
          label: "Classify intent",
          params: {
            systemPrompt:
              "Classify the user's message as either 'question' or 'compliment'. Reply with exactly one of those two words.",
            userPrompt: "{{ $trigger.payload.text }}",
            temperature: 0,
          },
        },
      },
      {
        id: "n_branch",
        type: "flow.branch",
        typeVersion: 1,
        position: { x: 620, y: 200 },
        data: {
          label: "Question?",
          params: {
            condition: "{{ $node['n_classify'].out.completion }}",
            truthyLabel: "yes",
            falsyLabel: "no",
          },
        },
      },
      {
        id: "n_yes",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 920, y: 100 },
        data: {
          label: "Reply: question",
          params: { variable: "reply", value: "Thanks for the question — investigating now." },
        },
      },
      {
        id: "n_no",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 920, y: 300 },
        data: {
          label: "Reply: compliment",
          params: { variable: "reply", value: "Glad you liked it!" },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_classify" },
      { id: "e2", source: "n_classify", target: "n_branch" },
      { id: "e3", source: "n_branch", target: "n_yes", label: "yes" },
      { id: "e4", source: "n_branch", target: "n_no", label: "no" },
    ],
  })
}

function skillBundleTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_skill_bundle",
    name: "Skills + AI",
    description:
      "Bundles selected skills into the prompt of a downstream AI step. Configure the skill ids on action.skill.invoke; the AI step then references the rendered markdown.",
    icon: "Sparkles",
    tags: ["skill", "ai"],
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 60, y: 140 },
        data: { label: "Run", params: {} },
      },
      {
        id: "n_skills",
        type: "action.skill.invoke",
        typeVersion: 1,
        position: { x: 340, y: 140 },
        data: {
          label: "Bundle skills",
          params: {
            // Comma-separated list of skill ids; empty by default so the
            // template is runnable without setup.
            skillIds: "",
          },
        },
      },
      {
        id: "n_prompt",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 660, y: 140 },
        data: {
          label: "Use skills",
          params: {
            systemPrompt:
              "{{ $node['n_skills'].out.markdown }}\n\nFollow the skills above when answering.",
            userPrompt: "Tell me what skills are available right now.",
            temperature: 0.5,
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_skills" },
      { id: "e2", source: "n_skills", target: "n_prompt" },
    ],
  })
}

// ── Phase 5+ templates — use the executors registered in built-ins.ts ────

function inboundTriageTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_inbound_triage",
    name: "Inbound triage",
    description:
      "Inbound platform message → AI classify → branch to high-priority handler / draft / drop. " +
      "Wire your Telegram or Slack adapter and the workflow auto-routes incoming messages.",
    icon: "Inbox",
    tags: ["connector", "ai", "triage"],
    nodes: [
      {
        id: "n_inbound",
        type: "trigger.connector.inbound",
        typeVersion: 1,
        position: { x: 0, y: 80 },
        data: { label: "Incoming message", params: {} },
      },
      {
        id: "n_classify",
        type: "ai.classify",
        typeVersion: 1,
        position: { x: 280, y: 80 },
        data: {
          label: "Classify",
          params: {
            input: "{{ $trigger.payload.text }}",
            labels: ["urgent", "normal", "spam"],
            labelsRaw: "urgent, normal, spam",
          },
        },
      },
      {
        id: "n_switch",
        type: "flow.switch",
        typeVersion: 1,
        position: { x: 560, y: 80 },
        data: {
          label: "Route by label",
          params: {
            subject: "{{ $node['n_classify'].out.label }}",
            cases: [
              { value: "urgent", label: "urgent" },
              { value: "spam", label: "spam" },
            ],
            defaultLabel: "default",
          },
        },
      },
      {
        id: "n_draft",
        type: "action.connector.draft",
        typeVersion: 1,
        position: { x: 840, y: 0 },
        data: {
          label: "Draft urgent reply",
          params: {
            conversationKey: "{{ $trigger.payload.conversationKey }}",
            sessionId: "{{ $trigger.payload.sessionId }}",
            content: "Urgent: forwarded to oncall.",
          },
        },
      },
      {
        id: "n_default",
        type: "action.connector.send",
        typeVersion: 1,
        position: { x: 840, y: 160 },
        data: {
          label: "Auto-reply",
          params: {
            adapterId: "{{ $trigger.payload.adapterId }}",
            conversationKey: "{{ $trigger.payload.conversationKey }}",
            content: "Thanks — I'll get back to you shortly.",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_inbound", target: "n_classify" },
      { id: "e2", source: "n_classify", target: "n_switch" },
      { id: "e3", source: "n_switch", target: "n_draft", label: "urgent" },
      { id: "e4", source: "n_switch", target: "n_default", label: "default" },
    ],
  })
}

function dailyDigestTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_daily_digest",
    name: "Daily digest",
    description:
      "Cron trigger fires every weekday at 09:00 → fetch top items → AI summarise → send through a connector. Edit the cron to change cadence.",
    icon: "Clock",
    tags: ["cron", "ai", "connector"],
    nodes: [
      {
        id: "n_cron",
        type: "trigger.cron",
        typeVersion: 1,
        position: { x: 0, y: 80 },
        data: { label: "Every weekday 09:00", params: { cron: "0 9 * * 1-5" } },
      },
      {
        id: "n_http",
        type: "io.http",
        typeVersion: 1,
        position: { x: 240, y: 80 },
        data: {
          label: "Fetch source",
          params: {
            method: "GET",
            url: "https://hacker-news.firebaseio.com/v0/topstories.json",
          },
        },
      },
      {
        id: "n_summary",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 480, y: 80 },
        data: {
          label: "Summarise",
          params: {
            systemPrompt: "Summarise this list as a 5-bullet morning digest.",
            userPrompt: "{{ $node['n_http'].out.body }}",
            temperature: 0.3,
          },
        },
      },
      {
        id: "n_send",
        type: "action.connector.send",
        typeVersion: 1,
        position: { x: 720, y: 80 },
        data: {
          label: "Send digest",
          params: {
            adapterId: "telegram_main",
            conversationKey: "ops",
            content: "{{ $node['n_summary'].out.completion }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_cron", target: "n_http" },
      { id: "e2", source: "n_http", target: "n_summary" },
      { id: "e3", source: "n_summary", target: "n_send" },
    ],
  })
}

function ragFaqTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_rag_faq",
    name: "RAG-backed FAQ reply",
    description:
      "Chat message → vector-search the bound twin → grounded AI reply. Drop in any twin id + character to deploy a personal knowledge bot.",
    icon: "Brain",
    tags: ["chat", "twin", "rag", "ai"],
    nodes: [
      {
        id: "n_chat",
        type: "trigger.chat.message",
        typeVersion: 1,
        position: { x: 0, y: 80 },
        data: { label: "On chat message", params: {} },
      },
      {
        id: "n_rag",
        type: "action.twin.rag",
        typeVersion: 1,
        position: { x: 240, y: 80 },
        data: {
          label: "Retrieve context",
          params: {
            twinId: "twin_demo",
            query: "{{ $trigger.payload.text }}",
            topK: 6,
          },
        },
      },
      {
        id: "n_answer",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 480, y: 80 },
        data: {
          label: "Grounded answer",
          params: {
            systemPrompt:
              "Answer using ONLY the context below. If you don't know, say so.\n\nCONTEXT:\n{{ $node['n_rag'].out.chunks }}",
            userPrompt: "{{ $trigger.payload.text }}",
            temperature: 0.2,
          },
        },
      },
      {
        id: "n_send",
        type: "action.character.send",
        typeVersion: 1,
        position: { x: 720, y: 80 },
        data: {
          label: "Reply",
          params: {
            characterId: "{{ $trigger.payload.characterId }}",
            sessionId: "{{ $trigger.payload.sessionId }}",
            content: "{{ $node['n_answer'].out.completion }}",
            role: "assistant",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_chat", target: "n_rag" },
      { id: "e2", source: "n_rag", target: "n_answer" },
      { id: "e3", source: "n_answer", target: "n_send" },
    ],
  })
}

function webhookEchoTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_webhook_echo",
    name: "Webhook → AI → respond",
    description:
      "Inbound webhook → AI rewrite of the body → echoed back as the HTTP response. Desktop only — relies on the Tauri webhook router.",
    icon: "Webhook",
    tags: ["webhook", "ai", "desktop-only"],
    nodes: [
      {
        id: "n_in",
        type: "trigger.webhook",
        typeVersion: 1,
        position: { x: 0, y: 80 },
        data: {
          label: "On webhook",
          params: { path: "echo", method: "POST", responseStatus: 200 },
        },
      },
      {
        id: "n_rewrite",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 240, y: 80 },
        data: {
          label: "Rewrite",
          params: {
            systemPrompt: "Rewrite the user message in formal English.",
            userPrompt: "{{ $trigger.payload.body }}",
          },
        },
      },
      {
        id: "n_out",
        type: "io.webhook.respond",
        typeVersion: 1,
        position: { x: 480, y: 80 },
        data: {
          label: "Respond",
          params: {
            status: 200,
            body: "{{ $node['n_rewrite'].out.completion }}",
            headersJson: '{ "Content-Type": "text/plain" }',
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_in", target: "n_rewrite" },
      { id: "e2", source: "n_rewrite", target: "n_out" },
    ],
  })
}

function loopOverItemsTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_loop_over_items",
    name: "Loop over items",
    description:
      "Manual trigger → fetch list → loop with a per-item AI summary → join results into a single output. Demonstrates flow.loop and aggregation.",
    icon: "Repeat",
    tags: ["loop", "ai"],
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 80 },
        data: { label: "Run", params: {} },
      },
      {
        id: "n_fetch",
        type: "io.http",
        typeVersion: 1,
        position: { x: 240, y: 80 },
        data: {
          label: "Fetch items",
          params: {
            method: "GET",
            url: "https://jsonplaceholder.typicode.com/posts?_limit=5",
          },
        },
      },
      {
        id: "n_loop",
        type: "flow.loop",
        typeVersion: 1,
        position: { x: 480, y: 80 },
        data: {
          label: "For each post",
          params: {
            mode: "forEach",
            inputExpression: "{{ $node['n_fetch'].out.body }}",
            bodyExpression: "$item.title",
            maxIterations: 100,
          },
        },
      },
      {
        id: "n_print",
        type: "data.template",
        typeVersion: 1,
        position: { x: 720, y: 80 },
        data: {
          label: "Render summary",
          params: {
            template:
              "Processed {{ $node['n_loop'].out.iterations }} items:\n{{ $node['n_loop'].out.items }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_fetch" },
      { id: "e2", source: "n_fetch", target: "n_loop" },
      { id: "e3", source: "n_loop", target: "n_print" },
    ],
  })
}

function subworkflowOrchestratorTemplate(): VisualWorkflow {
  return template({
    id: "wf_builtin_subworkflow_orchestrator",
    name: "Subworkflow orchestrator",
    description:
      "Manual trigger → run two subworkflows in parallel via flow.split → join results → AI merge. Demonstrates composition.",
    icon: "Workflow",
    tags: ["subworkflow", "split", "join", "ai"],
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 120 },
        data: { label: "Run", params: {} },
      },
      {
        id: "n_split",
        type: "flow.split",
        typeVersion: 1,
        position: { x: 220, y: 120 },
        data: {
          label: "Fan out",
          params: { branchLabels: ["A", "B"] },
        },
      },
      {
        id: "n_subA",
        type: "flow.subworkflow",
        typeVersion: 1,
        position: { x: 440, y: 40 },
        data: {
          label: "Sub A",
          params: { workflowId: "wf_builtin_hello_world" },
        },
      },
      {
        id: "n_subB",
        type: "flow.subworkflow",
        typeVersion: 1,
        position: { x: 440, y: 200 },
        data: {
          label: "Sub B",
          params: { workflowId: "wf_builtin_loop_over_items" },
        },
      },
      {
        id: "n_join",
        type: "flow.join",
        typeVersion: 1,
        position: { x: 680, y: 120 },
        data: {
          label: "Join",
          params: { joinPolicy: "all" },
        },
      },
      {
        id: "n_merge",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 900, y: 120 },
        data: {
          label: "Merge",
          params: {
            systemPrompt: "Combine the two upstream results into one short paragraph.",
            userPrompt: "A: {{ $node['n_subA'].out }}\n\nB: {{ $node['n_subB'].out }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_split" },
      { id: "e2", source: "n_split", target: "n_subA", label: "A" },
      { id: "e3", source: "n_split", target: "n_subB", label: "B" },
      { id: "e4", source: "n_subA", target: "n_join" },
      { id: "e5", source: "n_subB", target: "n_join" },
      { id: "e6", source: "n_join", target: "n_merge" },
    ],
  })
}

/**
 * Returns the in-memory list of built-in templates. Pure — no Dexie access —
 * so it can be safely consumed by tests and the templates tab without
 * requiring a database.
 */
export function buildBuiltInWorkflowTemplates(): VisualWorkflow[] {
  return [
    helloWorldTemplate(),
    httpDataPipelineTemplate(),
    conditionalReplyTemplate(),
    skillBundleTemplate(),
    inboundTriageTemplate(),
    dailyDigestTemplate(),
    ragFaqTemplate(),
    webhookEchoTemplate(),
    loopOverItemsTemplate(),
    subworkflowOrchestratorTemplate(),
  ]
}

/**
 * Idempotent insert wrapper. Called from `lib/db/seed.ts` on app boot.
 * Returns the count of rows actually written so the caller can log a
 * one-line summary.
 */
export async function seedBuiltInWorkflowTemplates(): Promise<number> {
  const templates = buildBuiltInWorkflowTemplates()
  if (templates.length === 0) return 0
  await seedBuiltInWorkflows(templates)
  return templates.length
}
