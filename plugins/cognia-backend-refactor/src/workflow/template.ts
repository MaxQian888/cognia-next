/**
 * "Go Backend Refactor Pipeline" workflow template.
 *
 * The editing spine of the suite. A clean DAG — cognia's workflow runtime runs
 * each node once (no re-execution) and only permits cycles through
 * flow.loop/flow.wait, so a true "retry forever" loop is not expressible.
 * Instead this encodes a **bounded one-retry verify loop** and puts two
 * independent checks in front of the only step that writes git history:
 *
 *   trigger → clean ─ success → analyze → plan → refactor → gate1
 *              └ failure → stopDirty (fail)
 *   gate1 ─ success → ok1 ┐
 *         └ failure → fix1 → gate2 ─ success → ok2 ┤
 *                                  └ failure → stopGate (fail)
 *   ok1 ┴ ok2 → test → cover → diff → review → verdict
 *   verdict ─ true (VERDICT: APPROVE) → doc → summary → approve
 *           └ false (REQUEST CHANGES / no verdict) → stopChanges (fail)
 *   approve ─ approved → commit
 *           └ rejected / timed out → stopRejected (fail)
 *
 * - `clean` refuses to start on a working tree with uncommitted or untracked
 *   files, so every change the commit stages was made by THIS run.
 * - `verdict` routes on the reviewer's final `VERDICT:` line and fails
 *   CLOSED: anything but an unambiguous APPROVE stops before docs and commit.
 * - `approve` is a human gate (notification center / paired phone) showing
 *   the files about to be committed.
 * - `commit` stages tracked changes and the new files the run created — never
 *   `git add -A` over whatever else happens to be in the directory.
 * - Every give-up path ends on the plugin's `pipeline.stop` node, which FAILS
 *   the run with its reason. (The old give-up leaf was a `flow.set`, which
 *   completes, so a run that could not build was recorded as a success.)
 *
 * The `okN` passthroughs (flow.set) are deliberate: a gate's failure decision
 * unconditionally skips its *direct* success target, so the shared tail (`test`)
 * must converge through intermediates — `propagateSkip` then spares `test` while
 * any `okN` is still live (verified against `lib/workflow/runtime/orchestrator.ts`).
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
import { AGENT_TURN_KIND } from "../nodes/agent-turn"
import { PIPELINE_STOP_KIND } from "../nodes/stop"

const AGENT_TURN = nodeKind(AGENT_TURN_KIND)
const PIPELINE_STOP = nodeKind(PIPELINE_STOP_KIND)
const REPO = "{{ $vars.repoPath }}"
const GO_GATE = "go build ./... && go vet ./... && go test ./..."

/** Refuse to start unless the clone has no uncommitted or untracked files. */
export const CLEAN_TREE_CHECK =
  'git rev-parse --is-inside-work-tree >/dev/null && test -z "$(git status --porcelain)"'

/**
 * Stage exactly what the run changed: tracked modifications/deletions, plus
 * the files it created (untracked, not ignored). `clean` guaranteed there were
 * no untracked files at the start, so every one listed here is the run's own.
 */
export const COMMIT_COMMAND =
  "git add --update -- . && " +
  "git ls-files -z --others --exclude-standard | xargs -0 git add -- && " +
  'git commit -m "refactor: automated Go backend refactor pass"'

/** What the read-only reviewer is shown: the tracked diff, then the new files. */
export const REVIEW_DIFF_COMMAND = "git diff HEAD && git ls-files --others --exclude-standard"

/** The reviewer ends with exactly one of these lines (see the reviewer role). */
export const APPROVE_VERDICT_PATTERN = "VERDICT:\\s*APPROVE\\b"
export const REQUEST_CHANGES_VERDICT = "VERDICT: REQUEST CHANGES"

/** How long the commit approval waits before it counts as rejected. */
export const COMMIT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000

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

function stop(
  id: string,
  x: number,
  y: number,
  label: string,
  reason: string
): PluginWorkflowTemplateNode {
  return {
    id,
    type: PIPELINE_STOP,
    typeVersion: 1,
    position: { x, y },
    data: { label, params: { reason } },
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
  terminal("clean", 220, 0, "Require clean tree", CLEAN_TREE_CHECK, "branch"),
  stop(
    "stopDirty",
    220,
    180,
    "Stop: uncommitted changes",
    "The repository at repoPath has uncommitted or untracked files. Commit or stash them first, so the pipeline only ever commits its own changes."
  ),
  turn(
    "analyze",
    440,
    0,
    "analyst",
    "Analyze repo",
    "Scan the repository and produce the structured analysis + prioritized task list (end with the JSON block)."
  ),
  turn(
    "plan",
    660,
    0,
    "architect",
    "Plan refactor",
    "Using the analysis below, produce an ordered, build-green refactor plan with per-module acceptance criteria.\n\nANALYSIS:\n{{ $node['analyze'].text }}"
  ),
  turn(
    "refactor",
    880,
    0,
    "refactorer",
    "Refactor",
    "Carry out the plan below, module by module, keeping the build green (run go build/test as you go).\n\nPLAN:\n{{ $node['plan'].text }}"
  ),
  terminal("gate1", 1100, 0, "Go gate", GO_GATE, "branch"),
  setVar("ok1", 1320, -80, "Verified", "buildVerified"),
  turn(
    "fix1",
    1100,
    180,
    "refactorer",
    "Fix failures",
    "The verification gate failed. Diagnose and fix until `go build ./...` and `go test ./...` pass.\n\nGATE OUTPUT:\n{{ $node['gate1'].output }}"
  ),
  terminal("gate2", 1320, 180, "Re-verify", GO_GATE, "branch"),
  setVar("ok2", 1540, 100, "Verified (after fix)", "buildVerified"),
  stop(
    "stopGate",
    1320,
    340,
    "Stop: still failing",
    "The Go build/vet/test gate still fails after one automated fix attempt. Nothing was committed; inspect the working tree and fix it manually."
  ),
  turn(
    "test",
    1760,
    0,
    "tester",
    "Raise coverage",
    "Add or strengthen tests for the refactored packages toward the coverage target."
  ),
  terminal("cover", 1980, 0, "Coverage gate", "go test ./... -cover", "throw"),
  // The reviewer is read-only (no Bash), so the pipeline hands it the diff.
  terminal("diff", 2200, -180, "Collect diff", REVIEW_DIFF_COMMAND, "throw"),
  turn(
    "review",
    2200,
    0,
    "reviewer",
    "Review diff",
    `Review the change below for regressions, layering violations, and over-engineering. Finish with exactly one final line: "VERDICT: APPROVE" or "${REQUEST_CHANGES_VERDICT}".\n\nDIFF (followed by the new files it does not show; Read them):\n{{ $node['diff'].output }}`
  ),
  {
    id: "verdict",
    type: "flow.branch",
    typeVersion: 2,
    position: { x: 2420, y: 0 },
    data: {
      label: "Approved by reviewer?",
      params: {
        // Fail closed: only an explicit APPROVE line, with no REQUEST CHANGES
        // line anywhere, continues. A missing verdict routes to `false`.
        conditions: {
          combinator: "all",
          conditions: [
            {
              left: "{{ $node['review'].text }}",
              operator: "regex",
              right: APPROVE_VERDICT_PATTERN,
              caseSensitive: true,
            },
            {
              left: "{{ $node['review'].text }}",
              operator: "notContains",
              right: REQUEST_CHANGES_VERDICT,
              caseSensitive: true,
            },
          ],
        },
      },
    },
  },
  stop(
    "stopChanges",
    2420,
    180,
    "Stop: changes requested",
    "The reviewer did not approve the refactor (REQUEST CHANGES, or no clear verdict). Nothing was committed; read the Review step's output, then fix and re-run."
  ),
  turn(
    "doc",
    2640,
    0,
    "doc-writer",
    "Update docs",
    "Update README / ADRs / API docs to match the refactor."
  ),
  terminal("summary", 2860, 0, "List changes", "git status --short && git diff --stat", "throw"),
  {
    id: "approve",
    type: "action.approval.request",
    typeVersion: 1,
    position: { x: 3080, y: 0 },
    data: {
      label: "Approve commit",
      params: {
        title: "Commit the automated Go refactor?",
        message:
          "The reviewer approved the change. Approving commits these files in {{ $vars.repoPath }}:\n\n{{ $node['summary'].output }}",
        timeoutMs: COMMIT_APPROVAL_TIMEOUT_MS,
        onTimeout: "reject",
      },
    },
  },
  stop(
    "stopRejected",
    3080,
    180,
    "Stop: commit not approved",
    "The commit was rejected (or the approval timed out). The refactor is left uncommitted in the working tree for you to review."
  ),
  terminal("commit", 3300, 0, "Commit", COMMIT_COMMAND, "throw"),
]

function branch(
  id: string,
  source: string,
  handle: string,
  target: string
): PluginWorkflowTemplateEdge {
  return {
    id,
    source,
    sourceHandle: handle,
    target,
    label: handle,
    data: { kind: "conditional" },
  }
}

const EDGES: PluginWorkflowTemplateEdge[] = [
  { id: "e_trigger_clean", source: "trigger", target: "clean" },
  // Refuse to touch a tree that already carries someone's uncommitted work.
  branch("e_clean_analyze", "clean", "success", "analyze"),
  branch("e_clean_stopDirty", "clean", "failure", "stopDirty"),
  { id: "e_analyze_plan", source: "analyze", target: "plan" },
  { id: "e_plan_refactor", source: "plan", target: "refactor" },
  { id: "e_refactor_gate1", source: "refactor", target: "gate1" },
  // gate1 branches on the Go toolchain exit code.
  branch("e_gate1_ok1", "gate1", "success", "ok1"),
  branch("e_gate1_fix1", "gate1", "failure", "fix1"),
  // one bounded fix attempt, then re-verify; a second failure fails the run.
  { id: "e_fix1_gate2", source: "fix1", target: "gate2" },
  branch("e_gate2_ok2", "gate2", "success", "ok2"),
  branch("e_gate2_stopGate", "gate2", "failure", "stopGate"),
  // both verified paths converge on the shared tail through the okN passthroughs.
  { id: "e_ok1_test", source: "ok1", target: "test" },
  { id: "e_ok2_test", source: "ok2", target: "test" },
  { id: "e_test_cover", source: "test", target: "cover" },
  { id: "e_cover_diff", source: "cover", target: "diff" },
  { id: "e_diff_review", source: "diff", target: "review" },
  { id: "e_review_verdict", source: "review", target: "verdict" },
  // Only an approving reviewer lets the run reach docs and the commit gate.
  branch("e_verdict_doc", "verdict", "true", "doc"),
  branch("e_verdict_stopChanges", "verdict", "false", "stopChanges"),
  { id: "e_doc_summary", source: "doc", target: "summary" },
  { id: "e_summary_approve", source: "summary", target: "approve" },
  // A person approves the exact file list before anything is committed.
  branch("e_approve_commit", "approve", "approved", "commit"),
  branch("e_approve_stopRejected", "approve", "rejected", "stopRejected"),
]

export const REFACTOR_PIPELINE_TEMPLATE = defineWorkflowTemplate({
  id: "backend-refactor-pipeline",
  name: "Go Backend Refactor Pipeline",
  description:
    "End-to-end refactor of a Go backend (desktop only): analyze → plan → refactor → go gate (one bounded fix-and-re-verify) → raise coverage → review → docs → your approval → commit. Stops without committing if the tree is dirty, the build keeps failing, the reviewer requests changes, or you reject. Set the repoPath variable to your clone.",
  category: "automation",
  icon: "Wrench",
  complexity: "advanced",
  nodes: NODES,
  edges: EDGES,
  requires: { pluginNodeKinds: [AGENT_TURN, PIPELINE_STOP] },
}) satisfies PluginWorkflowTemplateDef
