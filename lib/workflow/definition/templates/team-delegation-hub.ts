/**
 * Built-in template B6 — Delegation hub: classify a request, then route it to
 * the right agent system on behalf of a coordinating team.
 *
 * Demonstrates the full `action.team.delegate` target surface:
 *   - "research"  → an Employee Digital Twin (persona + RAG pre-injected)
 *   - "coding"    → an external agent runtime (Claude Code)
 *   - everything else → a plain background agent
 *
 * A coordinating team is auto-composed first (autoStart OFF — it exists only
 * as the delegation source / audit trail), the winning branch's result is
 * posted back onto the team blackboard via `action.team.message`.
 *
 * Node count: 9. Complexity: advanced.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

export function teamDelegationHubTemplate(): VisualWorkflow {
  return {
    id: "wf_builtin_team_delegation_hub",
    schemaVersion: 1,
    name: "Team delegation hub",
    description:
      "Classifies the request (research / coding / other), then delegates it on behalf of an auto-composed coordinator team to a digital twin, Claude Code, or a background agent — and posts the outcome to the team blackboard.",
    icon: "Share2",
    tags: ["team", "delegate", "twin", "agents", "advanced"],
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
        position: { x: 40, y: 260 },
        data: { label: "Run with request", params: {} },
      },
      {
        id: "n_compose",
        type: "action.team.compose",
        typeVersion: 1,
        position: { x: 280, y: 260 },
        data: {
          label: "Coordinator team",
          params: {
            objective: "Coordinate delegated work for: {{ $trigger.payload.request }}",
            name: "Delegation coordinator",
            maxRoster: 2,
            autoStart: false,
          },
        },
      },
      {
        id: "n_classify",
        type: "ai.classify",
        typeVersion: 1,
        position: { x: 540, y: 260 },
        data: {
          label: "Classify request",
          params: {
            input: "{{ $trigger.payload.request }}",
            labels: ["research", "coding", "other"],
            labelsRaw: "research, coding, other",
          },
        },
      },
      {
        id: "n_switch",
        type: "flow.switch",
        typeVersion: 1,
        position: { x: 800, y: 260 },
        data: {
          label: "Route by kind",
          params: {
            subject: "{{ $node['n_classify'].out.label }}",
            cases: [
              { value: "research", label: "research" },
              { value: "coding", label: "coding" },
            ],
            defaultLabel: "default",
          },
        },
      },
      {
        id: "n_twin",
        type: "action.team.delegate",
        typeVersion: 1,
        position: { x: 1080, y: 80 },
        data: {
          label: "Delegate to twin",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            target: "twin",
            twinId: "twin_demo",
            prompt: "{{ $trigger.payload.request }}",
            reason: "research request routed to digital twin",
            awaitCompletion: true,
          },
        },
      },
      {
        id: "n_external",
        type: "action.team.delegate",
        typeVersion: 1,
        position: { x: 1080, y: 260 },
        data: {
          label: "Delegate to Claude Code",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            target: "external",
            targetAgentId: "claude-code",
            prompt: "{{ $trigger.payload.request }}",
            reason: "coding request routed to external agent",
            awaitCompletion: true,
          },
        },
      },
      {
        id: "n_background",
        type: "action.team.delegate",
        typeVersion: 1,
        position: { x: 1080, y: 440 },
        data: {
          label: "Delegate to background agent",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            target: "background",
            prompt: "{{ $trigger.payload.request }}",
            systemPrompt: "You are a generalist assistant. Answer concisely and completely.",
            reason: "general request routed to background agent",
            awaitCompletion: true,
          },
        },
      },
      {
        id: "n_join",
        type: "flow.join",
        typeVersion: 1,
        position: { x: 1360, y: 260 },
        data: {
          label: "First result",
          params: { mode: "any" },
        },
      },
      {
        id: "n_post",
        type: "action.team.message",
        typeVersion: 1,
        position: { x: 1620, y: 260 },
        data: {
          label: "Post outcome to blackboard",
          params: {
            teamId: "{{ $node['n_compose'].out.teamId }}",
            content:
              "Delegated request settled ({{ $node['n_classify'].out.label }}): {{ $node['n_join'].out }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_start", target: "n_compose" },
      { id: "e2", source: "n_compose", target: "n_classify" },
      { id: "e3", source: "n_classify", target: "n_switch" },
      { id: "e4", source: "n_switch", target: "n_twin", label: "research" },
      { id: "e5", source: "n_switch", target: "n_external", label: "coding" },
      { id: "e6", source: "n_switch", target: "n_background", label: "default" },
      { id: "e7", source: "n_twin", target: "n_join" },
      { id: "e8", source: "n_external", target: "n_join" },
      { id: "e9", source: "n_background", target: "n_join" },
      { id: "e10", source: "n_join", target: "n_post" },
    ],
  }
}
