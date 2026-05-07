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
