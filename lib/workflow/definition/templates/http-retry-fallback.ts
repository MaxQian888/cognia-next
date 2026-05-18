/**
 * Built-in template B1 — HTTP request with manual retry + fallback.
 *
 * Demonstrates the "try once, branch on failure, wait + retry once, fall
 * through to an AI-summarized alert when both attempts fail" pattern. The
 * graph is intentionally LINEAR (no cycles) so it composes with the
 * existing topological scheduler and renders cleanly in the editor; the
 * "retry" is expressed as a second `io.http` node guarded by a branch.
 *
 * Node count: 8. Complexity: advanced.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

export function httpRetryFallbackTemplate(): VisualWorkflow {
  return {
    id: "wf_builtin_http_retry_fallback",
    schemaVersion: 1,
    name: "HTTP retry with fallback",
    description:
      "Calls an HTTP endpoint, retries once with exponential backoff if it returns 5xx, and falls through to an AI-summarized alert when both attempts fail. Reusable scaffold for any external-API integration that needs graceful degradation.",
    icon: "AlertTriangle",
    tags: ["http", "resilience", "ai", "advanced"],
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
        position: { x: 80, y: 200 },
        data: { label: "Run", params: {} },
      },
      {
        id: "n_http_1",
        type: "io.http",
        typeVersion: 1,
        position: { x: 320, y: 200 },
        data: {
          label: "Try API call",
          params: {
            method: "GET",
            url: "https://api.example.com/v1/widgets",
            timeoutMs: 5000,
          },
        },
      },
      {
        id: "n_branch_1",
        type: "flow.branch",
        typeVersion: 1,
        position: { x: 580, y: 200 },
        data: {
          label: "5xx?",
          params: {
            condition: "{{ $node['n_http_1'].out.status >= 500 }}",
          },
          notes: "True branch → retry. False branch → fall through to summarize.",
        },
      },
      {
        id: "n_wait",
        type: "flow.wait",
        typeVersion: 1,
        position: { x: 820, y: 100 },
        data: {
          label: "Backoff 2s",
          params: { durationMs: 2000 },
          notes: "Exponential — bump to 4s for attempt 3 if you extend the chain.",
        },
      },
      {
        id: "n_http_2",
        type: "io.http",
        typeVersion: 1,
        position: { x: 1060, y: 100 },
        data: {
          label: "Retry API call",
          params: {
            method: "GET",
            url: "https://api.example.com/v1/widgets",
            timeoutMs: 10000,
          },
        },
      },
      {
        id: "n_branch_2",
        type: "flow.branch",
        typeVersion: 1,
        position: { x: 1320, y: 100 },
        data: {
          label: "Still 5xx?",
          params: {
            condition: "{{ $node['n_http_2'].out.status >= 500 }}",
          },
        },
      },
      {
        id: "n_fallback",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 1580, y: 100 },
        data: {
          label: "Summarize failure",
          params: {
            systemPrompt:
              "You are an SRE assistant. Produce a one-paragraph incident summary suitable for posting to an oncall channel.",
            userPrompt:
              "Endpoint: https://api.example.com/v1/widgets\nAttempt 1 status: {{ $node['n_http_1'].out.status }}\nAttempt 2 status: {{ $node['n_http_2'].out.status }}\nLast body: {{ $node['n_http_2'].out.body }}",
            temperature: 0.2,
          },
        },
      },
      {
        id: "n_alert",
        type: "action.connector.send",
        typeVersion: 1,
        position: { x: 1840, y: 100 },
        data: {
          label: "Send alert",
          params: {
            connectorRef: "ops-channel",
            body: "{{ $node['n_fallback'].out.completion }}",
          },
          notes: "Configure connectorRef in the connector settings before running.",
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_http_1" },
      { id: "e2", source: "n_http_1", target: "n_branch_1" },
      { id: "e3", source: "n_branch_1", target: "n_wait", label: "5xx" },
      { id: "e4", source: "n_wait", target: "n_http_2" },
      { id: "e5", source: "n_http_2", target: "n_branch_2" },
      { id: "e6", source: "n_branch_2", target: "n_fallback", label: "still failed" },
      { id: "e7", source: "n_fallback", target: "n_alert" },
    ],
  }
}
