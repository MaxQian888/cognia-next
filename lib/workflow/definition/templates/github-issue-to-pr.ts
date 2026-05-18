/**
 * Built-in template B4 — GitHub Issue → PR with desktop verification.
 *
 * Demonstrates the longest chain of any built-in template: GitHub webhook
 * → AI extract → openPR → desktop screenshot → MCP plugin tool (run
 * tests) → success/failure branch → mergePR / commentPR + closeIssue.
 *
 * Exercises every cross-subsystem touchpoint that ADR-0011 left as
 * "stub-only" in Phase 1 (mcp.invokeTool, github.openPr, github.mergePr,
 * github.closeIssue) so users can see what a "real" end-to-end automation
 * looks like once those executors fill in.
 *
 * Node count: 11. Complexity: advanced.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

export function githubIssueToPrTemplate(): VisualWorkflow {
  return {
    id: "wf_builtin_github_issue_to_pr",
    schemaVersion: 1,
    name: "GitHub Issue → PR with verify",
    description:
      "When an issue is labeled 'auto-fix', extract the requirements, open a PR with a draft fix, screenshot the dev preview, run the test suite via an MCP plugin tool, and merge/close on success — or comment with logs on failure.",
    icon: "GitMerge",
    tags: ["github", "ai", "desktop", "mcp", "advanced", "end-to-end"],
    isTemplate: true,
    isBuiltIn: true,
    complexity: "advanced",
    createdAt: NOW,
    updatedAt: NOW,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 280 },
        data: {
          label: "Issue labeled",
          params: {
            events: ["issues.labeled"],
            filter: "{{ $trigger.payload.body.label.name === 'auto-fix' }}",
          },
        },
      },
      {
        id: "n_extract",
        type: "ai.extract",
        typeVersion: 1,
        position: { x: 360, y: 280 },
        data: {
          label: "Parse issue",
          params: {
            systemPrompt:
              "Extract structured requirements from a GitHub issue. Return JSON with shape { summary: string, acceptanceCriteria: string[], affectedFiles: string[] }.",
            userPrompt:
              "Title: {{ $trigger.payload.body.issue.title }}\n\nBody:\n{{ $trigger.payload.body.issue.body }}",
          },
        },
      },
      {
        id: "n_open_pr",
        type: "action.github.openPr",
        typeVersion: 1,
        position: { x: 640, y: 280 },
        data: {
          label: "Open draft PR",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            branch: "auto-fix/{{ $trigger.payload.body.issue.number }}",
            base: "main",
            title: "[auto-fix] {{ $node['n_extract'].out.summary }}",
            body: "Closes #{{ $trigger.payload.body.issue.number }}\n\n## Acceptance criteria\n{{ $node['n_extract'].out.acceptanceCriteria }}",
            draft: true,
          },
        },
      },
      {
        id: "n_screenshot",
        type: "action.desktop.screenshot",
        typeVersion: 1,
        position: { x: 920, y: 280 },
        data: {
          label: "Capture preview",
          params: {
            region: "fullscreen",
            saveAs: "auto-fix-preview-{{ $trigger.payload.body.issue.number }}.png",
          },
          notes: "Run after the dev preview is up so the artifact attaches to the PR body.",
        },
      },
      {
        id: "n_run_tests",
        type: "action.mcp.invokeTool",
        typeVersion: 1,
        position: { x: 1200, y: 280 },
        data: {
          label: "Run tests via MCP",
          params: {
            serverId: "test-runner",
            toolName: "run_tests",
            arguments: {
              branch: "auto-fix/{{ $trigger.payload.body.issue.number }}",
            },
          },
        },
      },
      {
        id: "n_check",
        type: "flow.branch",
        typeVersion: 1,
        position: { x: 1480, y: 280 },
        data: {
          label: "Tests pass?",
          params: {
            condition: "{{ $node['n_run_tests'].out.passed === true }}",
          },
        },
      },
      {
        id: "n_comment_pass",
        type: "action.github.commentPr",
        typeVersion: 1,
        position: { x: 1760, y: 120 },
        data: {
          label: "Comment success",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            prNumber: "{{ $node['n_open_pr'].out.number }}",
            body: "All tests passed (run id: {{ $node['n_run_tests'].out.runId }}). Auto-merging.",
          },
        },
      },
      {
        id: "n_merge",
        type: "action.github.mergePr",
        typeVersion: 1,
        position: { x: 2040, y: 120 },
        data: {
          label: "Merge PR",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            prNumber: "{{ $node['n_open_pr'].out.number }}",
            mergeMethod: "squash",
          },
        },
      },
      {
        id: "n_close",
        type: "action.github.closeIssue",
        typeVersion: 1,
        position: { x: 2320, y: 120 },
        data: {
          label: "Close issue",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            issueNumber: "{{ $trigger.payload.body.issue.number }}",
            reason: "completed",
          },
        },
      },
      {
        id: "n_comment_fail",
        type: "action.github.commentPr",
        typeVersion: 1,
        position: { x: 1760, y: 440 },
        data: {
          label: "Comment failure",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            prNumber: "{{ $node['n_open_pr'].out.number }}",
            body: "Tests failed. Failing suites:\n{{ $node['n_run_tests'].out.failingSuites }}\n\nLeaving PR in draft for a human to take over.",
          },
        },
      },
      {
        id: "n_done",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 2600, y: 280 },
        data: {
          label: "Mark complete",
          params: {
            variable: "lastAutoFix",
            value:
              "{{ { issue: $trigger.payload.body.issue.number, pr: $node['n_open_pr'].out.number, passed: $node['n_run_tests'].out.passed } }}",
            scope: "static",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_extract" },
      { id: "e2", source: "n_extract", target: "n_open_pr" },
      { id: "e3", source: "n_open_pr", target: "n_screenshot" },
      { id: "e4", source: "n_screenshot", target: "n_run_tests" },
      { id: "e5", source: "n_run_tests", target: "n_check" },
      { id: "e6", source: "n_check", target: "n_comment_pass", label: "pass" },
      { id: "e7", source: "n_comment_pass", target: "n_merge" },
      { id: "e8", source: "n_merge", target: "n_close" },
      { id: "e9", source: "n_check", target: "n_comment_fail", label: "fail" },
      { id: "e10", source: "n_close", target: "n_done" },
      { id: "e11", source: "n_comment_fail", target: "n_done" },
    ],
  }
}
