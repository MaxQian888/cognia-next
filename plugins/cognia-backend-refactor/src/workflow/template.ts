/**
 * "Backend Refactor Pipeline" workflow template.
 *
 * The editing spine of the suite. A clean DAG — cognia's workflow runtime runs
 * each node once (no re-execution) and only permits cycles through
 * flow.loop/flow.wait, so a true "retry forever" loop is not expressible.
 * Instead this encodes a **bounded one-retry verify loop**:
 *
 *   refactor → gate1 ─ success → ok1 ┐
 *                     └ failure → fix1 → gate2 ─ success → ok2 ┤
 *                                                └ failure → failnote (dead-end)
 *                                          ok1 ┴ ok2 → test → cover → review → doc → commit
 *
 * The `okN` passthroughs (flow.set) are deliberate: a gate's failure decision
 * unconditionally skips its *direct* success target, so the shared tail (`test`)
 * must converge through intermediates — `propagateSkip` then spares `test` while
 * any `okN` is still live (verified against `lib/workflow/runtime/orchestrator.ts`).
 * On a second failure the run stops at `failnote` for manual inspection. The
 * role agents also self-verify (`go build/test`) within each turn, so the gate
 * is a checkpoint rather than the only safety net.
 *
 * Set a workflow variable `repoPath` (absolute path to the repo clone) before
 * running — every cwd / `$vars.repoPath` reference reads it.
 */

import { defineWorkflowTemplate } from "@cognia/plugin-sdk"
import type {
  PluginWorkflowTemplateDef,
  PluginWorkflowTemplateNode,
  PluginWorkflowTemplateEdge,
} from "@cognia/plugin-sdk"
import { nodeKind } from "../ids"

const AGENT_TURN = nodeKind("agent.turn")
const REPO = "{{ $vars.repoPath }}"
const GO_GATE = "go build ./... && go vet ./... && go test ./..."

function turn(
  id: string,
  x: number,
  y: number,
  role: string,
  label: string,
  prompt: string
): PluginWorkflowTemplateNode {
  return {
    id,
    type: AGENT_TURN,
    typeVersion: 1,
    position: { x, y },
    data: { label, params: { role, prompt, cwd: REPO } },
  }
}

function terminal(
  id: string,
  x: number,
  y: number,
  label: string,
  command: string,
  onFailure: "branch" | "throw"
): PluginWorkflowTemplateNode {
  return {
    id,
    type: "action.system.terminal",
    typeVersion: 1,
    position: { x, y },
    data: { label, params: { command, cwd: REPO, onFailure } },
  }
}

function setVar(
  id: string,
  x: number,
  y: number,
  label: string,
  variable: string
): PluginWorkflowTemplateNode {
  return {
    id,
    type: "flow.set",
    typeVersion: 1,
    position: { x, y },
    data: { label, params: { variable, value: true } },
  }
}

const NODES: PluginWorkflowTemplateNode[] = [
  {
    id: "note",
    type: "annotation.note",
    typeVersion: 1,
    position: { x: 0, y: -120 },
    data: {
      label: "Setup",
      params: {
        text: "Set a workflow variable `repoPath` to the absolute path of your repo clone before running. Every step's cwd reads {{ $vars.repoPath }}.",
      },
    },
  },
  {
    id: "trigger",
    type: "trigger.manual",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: "Run" },
  },
  turn(
    "analyze",
    220,
    0,
    "analyst",
    "Analyze repo",
    "Scan the repository and produce the structured analysis + prioritized task list (end with the JSON block)."
  ),
  turn(
    "plan",
    440,
    0,
    "architect",
    "Plan refactor",
    "Using the analysis below, produce an ordered, build-green refactor plan with per-module acceptance criteria.\n\nANALYSIS:\n{{ $node['analyze'].text }}"
  ),
  turn(
    "refactor",
    660,
    0,
    "refactorer",
    "Refactor",
    "Carry out the plan below, module by module, keeping the build green (run go build/test as you go).\n\nPLAN:\n{{ $node['plan'].text }}"
  ),
  terminal("gate1", 880, 0, "Go gate", GO_GATE, "branch"),
  setVar("ok1", 1100, -80, "Verified", "buildVerified"),
  turn(
    "fix1",
    880,
    180,
    "refactorer",
    "Fix failures",
    "The verification gate failed. Diagnose and fix until `go build ./...` and `go test ./...` pass.\n\nGATE OUTPUT:\n{{ $node['gate1'].output }}"
  ),
  terminal("gate2", 1100, 180, "Re-verify", GO_GATE, "branch"),
  setVar("ok2", 1320, 100, "Verified (after fix)", "buildVerified"),
  setVar("failnote", 1100, 340, "Needs manual fix", "needsManualReview"),
  turn(
    "test",
    1540,
    0,
    "tester",
    "Raise coverage",
    "Add or strengthen tests for the refactored packages toward the coverage target."
  ),
  terminal("cover", 1760, 0, "Coverage gate", "go test ./... -cover", "throw"),
  turn(
    "review",
    1980,
    0,
    "reviewer",
    "Review diff",
    "Review the change (git diff) for regressions, layering violations, and over-engineering. End with APPROVE or REQUEST CHANGES."
  ),
  turn(
    "doc",
    2200,
    0,
    "doc-writer",
    "Update docs",
    "Update README / ADRs / API docs to match the refactor."
  ),
  terminal(
    "commit",
    2420,
    0,
    "Commit",
    'git add -A && git commit -m "refactor: automated backend refactor pass"',
    "throw"
  ),
]

const EDGES: PluginWorkflowTemplateEdge[] = [
  { id: "e_trigger_analyze", source: "trigger", target: "analyze" },
  { id: "e_analyze_plan", source: "analyze", target: "plan" },
  { id: "e_plan_refactor", source: "plan", target: "refactor" },
  { id: "e_refactor_gate1", source: "refactor", target: "gate1" },
  // gate1 branches on the Go toolchain exit code.
  {
    id: "e_gate1_ok1",
    source: "gate1",
    sourceHandle: "success",
    target: "ok1",
    label: "success",
    data: { kind: "conditional" },
  },
  {
    id: "e_gate1_fix1",
    source: "gate1",
    sourceHandle: "failure",
    target: "fix1",
    label: "failure",
    data: { kind: "conditional" },
  },
  // one bounded fix attempt, then re-verify.
  { id: "e_fix1_gate2", source: "fix1", target: "gate2" },
  {
    id: "e_gate2_ok2",
    source: "gate2",
    sourceHandle: "success",
    target: "ok2",
    label: "success",
    data: { kind: "conditional" },
  },
  {
    id: "e_gate2_failnote",
    source: "gate2",
    sourceHandle: "failure",
    target: "failnote",
    label: "failure",
    data: { kind: "conditional" },
  },
  // both verified paths converge on the shared tail through the okN passthroughs.
  { id: "e_ok1_test", source: "ok1", target: "test" },
  { id: "e_ok2_test", source: "ok2", target: "test" },
  { id: "e_test_cover", source: "test", target: "cover" },
  { id: "e_cover_review", source: "cover", target: "review" },
  { id: "e_review_doc", source: "review", target: "doc" },
  { id: "e_doc_commit", source: "doc", target: "commit" },
]

export const REFACTOR_PIPELINE_TEMPLATE = defineWorkflowTemplate({
  id: "backend-refactor-pipeline",
  name: "Backend Refactor Pipeline",
  description:
    "End-to-end Go backend refactor: analyze → plan → refactor → go gate (with one bounded fix-and-re-verify) → raise coverage → review → docs → commit. Set the repoPath variable to your clone.",
  category: "automation",
  icon: "Wrench",
  complexity: "advanced",
  nodes: NODES,
  edges: EDGES,
  requires: { pluginNodeKinds: [AGENT_TURN] },
}) satisfies PluginWorkflowTemplateDef
