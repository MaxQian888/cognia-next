/**
 * Built-in template B3 — Inbox triage with Twin RAG.
 *
 * Demonstrates the full-stack pattern: inbound connector message →
 * PII-redacted payload → twin RAG lookup → AI intent classification →
 * 4-way switch into three character replies and one team escalation.
 *
 * Node count: 10. Complexity: advanced. The redaction step calls the
 * sandboxed `data.code` executor with a hand-rolled gate so it composes
 * cleanly with `lib/twin/ingest/redact.ts:hasNoLeakingPii` in production
 * runtimes (where the editor can swap the snippet for a direct import).
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

export function inboxTriageTwinTemplate(): VisualWorkflow {
  return {
    id: "wf_builtin_inbox_triage_twin",
    schemaVersion: 1,
    name: "Inbox triage with Twin RAG",
    description:
      "Receives an inbound connector message, redacts PII, retrieves relevant context from the employee Twin, classifies intent, and routes the reply to one of three character personas or escalates to a team.",
    icon: "Inbox",
    tags: ["connector", "twin", "ai", "advanced", "triage"],
    isTemplate: true,
    isBuiltIn: true,
    complexity: "advanced",
    createdAt: NOW,
    updatedAt: NOW,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n_inbound",
        type: "trigger.connector.inbound",
        typeVersion: 1,
        position: { x: 80, y: 260 },
        data: {
          label: "Inbound message",
          params: { connectorRef: "support-inbox" },
        },
      },
      {
        id: "n_redact",
        type: "data.code",
        typeVersion: 1,
        position: { x: 340, y: 260 },
        data: {
          label: "Redact PII",
          params: {
            language: "javascript",
            timeoutMs: 2000,
            code:
              "// Replace with `import { hasNoLeakingPii } from '@cognia/redact'`\n" +
              "// in a real runtime. Inline here so the template is self-contained.\n" +
              "const body = String($input.body ?? '');\n" +
              "const redacted = body\n" +
              "  .replace(/\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b/gi, '[email]')\n" +
              "  .replace(/\\b\\+?\\d[\\d\\s\\-()]{8,}\\d\\b/g, '[phone]');\n" +
              "return { redacted, originalLength: body.length };",
          },
        },
      },
      {
        id: "n_rag",
        type: "action.twin.rag",
        typeVersion: 1,
        position: { x: 600, y: 260 },
        data: {
          label: "Twin RAG lookup",
          params: {
            query: "{{ $node['n_redact'].out.redacted }}",
            topK: 5,
            scope: "support",
          },
          notes: "Returns top-K most-relevant prior tickets + KB chunks for grounding.",
        },
      },
      {
        id: "n_classify",
        type: "ai.classify",
        typeVersion: 1,
        position: { x: 860, y: 260 },
        data: {
          label: "Intent",
          params: {
            systemPrompt:
              "Classify the user's intent. Use one of: billing / technical / account / escalation. Use 'escalation' only when the message asks for a human or expresses anger.",
            labels: ["billing", "technical", "account", "escalation"],
            userPrompt: "{{ $node['n_redact'].out.redacted }}",
          },
        },
      },
      {
        id: "n_switch",
        type: "flow.switch",
        typeVersion: 1,
        position: { x: 1140, y: 260 },
        data: {
          label: "Route by intent",
          params: {
            on: "{{ $node['n_classify'].out.label }}",
            cases: ["billing", "technical", "account", "escalation"],
          },
        },
      },
      {
        id: "n_reply_billing",
        type: "action.character.send",
        typeVersion: 1,
        position: { x: 1440, y: 80 },
        data: {
          label: "Billing persona",
          params: {
            characterRef: "billing-assistant",
            body: "Context:\n{{ $node['n_rag'].out.summary }}\n\nUser:\n{{ $node['n_redact'].out.redacted }}",
          },
        },
      },
      {
        id: "n_reply_technical",
        type: "action.character.send",
        typeVersion: 1,
        position: { x: 1440, y: 220 },
        data: {
          label: "Technical persona",
          params: {
            characterRef: "tech-assistant",
            body: "Context:\n{{ $node['n_rag'].out.summary }}\n\nUser:\n{{ $node['n_redact'].out.redacted }}",
          },
        },
      },
      {
        id: "n_reply_account",
        type: "action.character.send",
        typeVersion: 1,
        position: { x: 1440, y: 360 },
        data: {
          label: "Account persona",
          params: {
            characterRef: "account-assistant",
            body: "Context:\n{{ $node['n_rag'].out.summary }}\n\nUser:\n{{ $node['n_redact'].out.redacted }}",
          },
        },
      },
      {
        id: "n_escalate",
        type: "action.team.task.dispatch",
        typeVersion: 1,
        position: { x: 1440, y: 520 },
        data: {
          label: "Escalate to humans",
          params: {
            teamRef: "support-tier-2",
            task: "Inbound ticket requires human handling.\n\nUser:\n{{ $node['n_redact'].out.redacted }}\n\nClassification: {{ $node['n_classify'].out.label }}",
          },
        },
      },
      {
        id: "n_log",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 1740, y: 260 },
        data: {
          label: "Record routing",
          params: {
            variable: "lastIntent",
            value: "{{ $node['n_classify'].out.label }}",
            scope: "static",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_inbound", target: "n_redact" },
      { id: "e2", source: "n_redact", target: "n_rag" },
      { id: "e3", source: "n_rag", target: "n_classify" },
      { id: "e4", source: "n_classify", target: "n_switch" },
      { id: "e5", source: "n_switch", target: "n_reply_billing", label: "billing" },
      { id: "e6", source: "n_switch", target: "n_reply_technical", label: "technical" },
      { id: "e7", source: "n_switch", target: "n_reply_account", label: "account" },
      { id: "e8", source: "n_switch", target: "n_escalate", label: "escalation" },
      { id: "e9", source: "n_reply_billing", target: "n_log" },
      { id: "e10", source: "n_reply_technical", target: "n_log" },
      { id: "e11", source: "n_reply_account", target: "n_log" },
      { id: "e12", source: "n_escalate", target: "n_log" },
    ],
  }
}
