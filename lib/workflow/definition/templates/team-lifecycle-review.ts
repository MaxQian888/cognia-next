/**
 * Built-in template B7 — Full team lifecycle with a multi-bot verification
 * gate.
 *
 * Composes a team WITHOUT starting it (so the graph shows the compose → brief
 * → run → inspect seams separately), posts a kickoff briefing to the team
 * blackboard, runs the lifecycle via `action.team.run`, reads the terminal
 * state, then fans the final result to two independent AI reviewers
 * (correctness / completeness) whose verdicts are merged into one report —
 * a lightweight "team does the work, a bot panel checks it" pipeline.
 *
 * Node count: 10. Complexity: advanced.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

export function teamLifecycleReviewTemplate(): VisualWorkflow {
  return {
    id: "wf_builtin_team_lifecycle_review",
    schemaVersion: 1,
    name: "Team lifecycle + review panel",
    description:
      "Composes an agent team from the payload objective, briefs it on the blackboard, runs the full lifecycle, then has two independent AI reviewers verify the team's final result before the merged report is stored.",
    icon: "Users",
    tags: ["team", "agents", "review", "ensemble", "advanced"],
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
        position: { x: 40, y: 240 },
        data: { label: "Run with objective", params: {} },
      },
      {
        id: "n_compose",
        type: "action.team.compose",
        typeVersion: 1,
        position: { x: 280, y: 240 },
        data: {
          label: "Compose team",
          params: {
            objective: "{{ $trigger.payload.objective }}",
            maxRoster: 4,
            autoStart: false,
          },
        },
      },
      {
        id: "n_brief",
        type: "action.team.message",
        typeVersion: 1,
        position: { x: 540, y: 240 },
        data: {
          label: "Kickoff briefing",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            content:
              "Kickoff: {{ $trigger.payload.objective }}\n\nDeliver a single consolidated result; flag blockers on this board.",
          },
        },
      },
      {
        id: "n_run",
        type: "action.team.run",
        typeVersion: 1,
        position: { x: 800, y: 240 },
        data: {
          label: "Run lifecycle",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            goal: "{{ $trigger.payload.objective }}",
          },
        },
      },
      {
        id: "n_status",
        type: "action.team.status",
        typeVersion: 1,
        position: { x: 1060, y: 240 },
        data: {
          label: "Read result",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            includeTasks: true,
            includeTeammates: false,
          },
        },
      },
      {
        id: "n_split",
        type: "flow.split",
        typeVersion: 1,
        position: { x: 1320, y: 240 },
        data: { label: "Fan out to reviewers", params: { branchLabels: ["A", "B"] } },
      },
      {
        id: "n_review_correct",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 1560, y: 120 },
        data: {
          label: "Correctness reviewer",
          params: {
            systemPrompt:
              "You verify factual and logical correctness. List concrete errors, or state 'PASS' if none.",
            userPrompt:
              "Objective:\n{{ $trigger.payload.objective }}\n\nTeam result:\n{{ $node['n_status'].out.finalResult }}",
            temperature: 0.1,
          },
        },
      },
      {
        id: "n_review_complete",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 1560, y: 360 },
        data: {
          label: "Completeness reviewer",
          params: {
            systemPrompt:
              "You verify completeness against the stated objective. List missing pieces, or state 'PASS' if none.",
            userPrompt:
              "Objective:\n{{ $trigger.payload.objective }}\n\nTeam result:\n{{ $node['n_status'].out.finalResult }}",
            temperature: 0.1,
          },
        },
      },
      {
        id: "n_join",
        type: "flow.join",
        typeVersion: 1,
        position: { x: 1820, y: 240 },
        data: { label: "Both verdicts", params: { mode: "all" } },
      },
      {
        id: "n_report",
        type: "data.template",
        typeVersion: 1,
        position: { x: 2080, y: 240 },
        data: {
          label: "Merged report",
          params: {
            template:
              "## Team result ({{ status }})\n\n{{ result }}\n\n### Correctness review\n{{ correctness }}\n\n### Completeness review\n{{ completeness }}",
            inputs: {
              status: "{{ $node['n_run'].out.status }}",
              result: "{{ $node['n_status'].out.finalResult }}",
              correctness: "{{ $node['n_review_correct'].out.completion }}",
              completeness: "{{ $node['n_review_complete'].out.completion }}",
            },
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_compose" },
      { id: "e2", source: "n_compose", target: "n_brief" },
      { id: "e3", source: "n_brief", target: "n_run" },
      { id: "e4", source: "n_run", target: "n_status" },
      { id: "e5", source: "n_status", target: "n_split" },
      { id: "e6", source: "n_split", target: "n_review_correct", label: "A" },
      { id: "e7", source: "n_split", target: "n_review_complete", label: "B" },
      { id: "e8", source: "n_review_correct", target: "n_join" },
      { id: "e9", source: "n_review_complete", target: "n_join" },
      { id: "e10", source: "n_join", target: "n_report" },
    ],
  }
}
