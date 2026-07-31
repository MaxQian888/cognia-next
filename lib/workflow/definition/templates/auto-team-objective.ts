/**
 * Built-in template B5 — Objective → auto-composed agent team → report.
 *
 * The fastest path from "one sentence" to a running multi-agent team:
 * `action.team.compose` plans the roster + tasks from the trigger payload
 * (PII-gated), starts the lifecycle immediately, then `action.team.status`
 * reads the terminal state so the digest step can report per-task outcomes.
 *
 * Node count: 5. Complexity: advanced. First template to exercise the
 * team.compose / team.status surface nodes.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

export function autoTeamObjectiveTemplate(): VisualWorkflow {
  return {
    id: "wf_builtin_auto_team_objective",
    schemaVersion: 1,
    name: "Auto team from objective",
    description:
      "Run with an objective in the payload — the workflow auto-composes an agent team (routing assessment, roster, task decomposition), runs it to completion, then reports the final result and per-task outcomes.",
    icon: "Wand2",
    tags: ["team", "agents", "auto", "advanced"],
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
        position: { x: 60, y: 160 },
        data: { label: "Run with objective", params: {} },
      },
      {
        id: "n_compose",
        type: "action.team.compose",
        typeVersion: 1,
        position: { x: 320, y: 160 },
        data: {
          label: "Compose + run team",
          params: {
            objective: "{{ $trigger.payload.objective }}",
            maxRoster: 5,
            autoStart: true,
          },
        },
      },
      {
        id: "n_status",
        type: "action.team.status",
        typeVersion: 1,
        position: { x: 620, y: 160 },
        data: {
          label: "Read terminal state",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            includeTasks: true,
            includeTeammates: true,
            includeDelegations: true,
          },
        },
      },
      {
        id: "n_digest",
        type: "data.template",
        typeVersion: 1,
        position: { x: 900, y: 160 },
        data: {
          label: "Format report",
          params: {
            template:
              "## Team run: {{ name }}\n\nStatus: **{{ status }}** ({{ pattern }})\n\n{{ finalResult }}\n\nTasks: {{ taskCounts }}",
            inputs: {
              name: "{{ $node['n_status'].out.name }}",
              status: "{{ $node['n_status'].out.status }}",
              pattern: "{{ $node['n_compose'].out.pattern }}",
              finalResult: "{{ $node['n_status'].out.finalResult }}",
              taskCounts: "{{ $node['n_status'].out.taskCounts }}",
            },
          },
        },
      },
      {
        id: "n_save",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 1180, y: 160 },
        data: {
          label: "Store report",
          params: {
            variable: "lastTeamReport",
            value: "{{ $node['n_digest'].out.text }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_compose" },
      { id: "e2", source: "n_compose", target: "n_status" },
      { id: "e3", source: "n_status", target: "n_digest" },
      { id: "e4", source: "n_digest", target: "n_save" },
    ],
  }
}
