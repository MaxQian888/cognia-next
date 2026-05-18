/**
 * Built-in template B2 — Parallel multi-analyst with split/join + voting.
 *
 * Demonstrates the "fan out one input to N specialized LLM analysts in
 * parallel, then join their outputs and vote a winner" pattern. Each
 * analyst has a different system prompt so the panel covers different
 * angles (correctness, security, performance, UX); the classifier picks
 * the most useful response to forward downstream.
 *
 * Node count: 12. Complexity: advanced. Exercises flow.split / flow.join
 * which weren't covered by any other built-in template before B2.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

export function parallelAnalystsTemplate(): VisualWorkflow {
  return {
    id: "wf_builtin_parallel_analysts",
    schemaVersion: 1,
    name: "Parallel multi-analyst",
    description:
      "Fans the input out to four specialised LLM analysts in parallel (correctness, security, performance, UX), joins the answers, then asks a classifier to pick the most useful one to forward to a character.",
    icon: "Network",
    tags: ["parallel", "ai", "advanced", "ensemble"],
    isTemplate: true,
    isBuiltIn: true,
    complexity: "advanced",
    createdAt: NOW,
    updatedAt: NOW,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 80, y: 320 },
        data: { label: "Run with payload", params: {} },
      },
      {
        id: "n_prepare",
        type: "data.transform",
        typeVersion: 1,
        position: { x: 320, y: 320 },
        data: {
          label: "Normalize payload",
          params: {
            kind: "map",
            expression: "{ subject: $trigger.payload.subject, body: $trigger.payload.body }",
          },
        },
      },
      {
        id: "n_split",
        type: "flow.split",
        typeVersion: 1,
        position: { x: 580, y: 320 },
        data: { label: "Fan out to 4", params: {} },
      },
      {
        id: "n_ai_correctness",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 860, y: 80 },
        data: {
          label: "Correctness analyst",
          params: {
            systemPrompt:
              "You audit logical correctness. Flag every factual error, contradiction, or invalid assumption. Return a bullet list.",
            userPrompt: "{{ $node['n_prepare'].out.body }}",
            temperature: 0.1,
          },
        },
      },
      {
        id: "n_ai_security",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 860, y: 240 },
        data: {
          label: "Security analyst",
          params: {
            systemPrompt:
              "You audit security: injection, auth, secret handling, supply-chain risk. Bullet list with severity.",
            userPrompt: "{{ $node['n_prepare'].out.body }}",
            temperature: 0.1,
          },
        },
      },
      {
        id: "n_ai_performance",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 860, y: 400 },
        data: {
          label: "Performance analyst",
          params: {
            systemPrompt:
              "You audit performance: hot paths, allocations, N+1 queries, render cost. Bullet list.",
            userPrompt: "{{ $node['n_prepare'].out.body }}",
            temperature: 0.1,
          },
        },
      },
      {
        id: "n_ai_ux",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 860, y: 560 },
        data: {
          label: "UX analyst",
          params: {
            systemPrompt:
              "You audit UX: clarity, accessibility, error states, mobile fit. Bullet list.",
            userPrompt: "{{ $node['n_prepare'].out.body }}",
            temperature: 0.2,
          },
        },
      },
      {
        id: "n_join",
        type: "flow.join",
        typeVersion: 1,
        position: { x: 1180, y: 320 },
        data: {
          label: "Gather all 4",
          params: { mode: "all" },
        },
      },
      {
        id: "n_vote",
        type: "ai.classify",
        typeVersion: 1,
        position: { x: 1440, y: 320 },
        data: {
          label: "Pick most-useful",
          params: {
            systemPrompt:
              "Given four analyst reports, pick the SINGLE most actionable one for the author. Return only one of: correctness, security, performance, ux.",
            labels: ["correctness", "security", "performance", "ux"],
            userPrompt:
              "Correctness:\n{{ $node['n_ai_correctness'].out.completion }}\n\nSecurity:\n{{ $node['n_ai_security'].out.completion }}\n\nPerformance:\n{{ $node['n_ai_performance'].out.completion }}\n\nUX:\n{{ $node['n_ai_ux'].out.completion }}",
          },
        },
      },
      {
        id: "n_format",
        type: "data.template",
        typeVersion: 1,
        position: { x: 1720, y: 320 },
        data: {
          label: "Format final reply",
          params: {
            template: "**Winner: {{ vote }}**\n\n{{ winner }}",
            inputs: {
              vote: "{{ $node['n_vote'].out.label }}",
              winner:
                "{{ $node['n_ai_' + $node['n_vote'].out.label.toLowerCase()].out.completion }}",
            },
          },
        },
      },
      {
        id: "n_send",
        type: "action.character.send",
        typeVersion: 1,
        position: { x: 2000, y: 320 },
        data: {
          label: "Reply via character",
          params: {
            characterRef: "default-reviewer",
            body: "{{ $node['n_format'].out.text }}",
          },
        },
      },
      {
        id: "n_log",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 2260, y: 320 },
        data: {
          label: "Record winner",
          params: {
            variable: "lastWinner",
            value: "{{ $node['n_vote'].out.label }}",
            scope: "static",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_prepare" },
      { id: "e2", source: "n_prepare", target: "n_split" },
      { id: "e3", source: "n_split", target: "n_ai_correctness", label: "A" },
      { id: "e4", source: "n_split", target: "n_ai_security", label: "B" },
      { id: "e5", source: "n_split", target: "n_ai_performance", label: "C" },
      { id: "e6", source: "n_split", target: "n_ai_ux", label: "D" },
      { id: "e7", source: "n_ai_correctness", target: "n_join" },
      { id: "e8", source: "n_ai_security", target: "n_join" },
      { id: "e9", source: "n_ai_performance", target: "n_join" },
      { id: "e10", source: "n_ai_ux", target: "n_join" },
      { id: "e11", source: "n_join", target: "n_vote" },
      { id: "e12", source: "n_vote", target: "n_format" },
      { id: "e13", source: "n_format", target: "n_send" },
      { id: "e14", source: "n_send", target: "n_log" },
    ],
  }
}
