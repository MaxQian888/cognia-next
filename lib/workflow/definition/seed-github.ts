/**
 * Built-in workflow templates for the GitHub Delivery plugin.
 *
 * Each template is a {@link VisualWorkflow} fragment that the user can fork
 * via "Use template". The graphs reference the 12 action.github.* executors
 * registered by the github-delivery plugin and a single trigger
 * (trigger.github.webhook or trigger.cron).
 *
 * Templates are intentionally minimal — just enough nodes to demonstrate the
 * pattern. Users will add policy, branching, AI prompts, etc. on top.
 */

import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const NOW = 1_730_000_000_000

function tmpl(
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
  }
}

// 1) PR auto-review — webhook on pull_request.opened/synchronize → AI review.
function prAutoReviewTemplate(): VisualWorkflow {
  return tmpl({
    id: "wf_builtin_gh_pr_auto_review",
    name: "[GitHub] PR auto-review",
    description:
      "When a PR is opened or updated, ask the AI for a review and either approve, comment, or request changes based on the AI's confidence.",
    icon: "GitPullRequest",
    tags: ["github", "ai", "review", "pr"],
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 140 },
        data: {
          label: "GitHub: PR opened/synced",
          params: { events: ["pull_request.opened", "pull_request.synchronize"] },
        },
      },
      {
        id: "n_ai",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 380, y: 140 },
        data: {
          label: "AI review",
          params: {
            systemPrompt:
              "You are a senior reviewer. Read the PR title + body + diff summary. Decide APPROVE / COMMENT / REQUEST_CHANGES. Be terse.",
            userPrompt:
              "{{ $trigger.payload.body.pull_request.title }}\n\n{{ $trigger.payload.body.pull_request.body }}",
          },
        },
      },
      {
        id: "n_review",
        type: "action.github.reviewPr",
        typeVersion: 1,
        position: { x: 720, y: 140 },
        data: {
          label: "Submit review",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            prNumber: "{{ $trigger.payload.body.pull_request.number }}",
            event: "COMMENT",
            body: "{{ $node['n_ai'].out.completion }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_ai" },
      { id: "e2", source: "n_ai", target: "n_review" },
    ],
  })
}

// 2) Issue triage — webhook on issues.opened → AI classify → label.
function issueTriageTemplate(): VisualWorkflow {
  return tmpl({
    id: "wf_builtin_gh_issue_triage",
    name: "[GitHub] Issue smart triage",
    description: "Labels newly opened issues by AI-classifying them into bug/feature/question.",
    icon: "Tag",
    tags: ["github", "ai", "issue", "triage"],
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 140 },
        data: {
          label: "GitHub: Issue opened",
          params: { events: ["issues.opened"] },
        },
      },
      {
        id: "n_classify",
        type: "ai.classify",
        typeVersion: 1,
        position: { x: 380, y: 140 },
        data: {
          label: "Classify",
          params: {
            text:
              "{{ $trigger.payload.body.issue.title }}\n\n{{ $trigger.payload.body.issue.body }}",
            categories: ["bug", "feature", "question"],
          },
        },
      },
      {
        id: "n_label",
        type: "action.github.labelIssue",
        typeVersion: 1,
        position: { x: 720, y: 140 },
        data: {
          label: "Apply label",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            issueNumber: "{{ $trigger.payload.body.issue.number }}",
            add: ["{{ $node['n_classify'].out.category }}"],
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_classify" },
      { id: "e2", source: "n_classify", target: "n_label" },
    ],
  })
}

// 3) Issue → PR loop — webhook on issues.labeled `cognia:claim` → runIssueLoop.
function issuePrLoopTemplate(): VisualWorkflow {
  return tmpl({
    id: "wf_builtin_gh_issue_pr_loop",
    name: "[GitHub] Issue → PR loop",
    description:
      "When an issue is labeled `cognia:claim`, run the AI worktree loop: clone, drive Claude Code, push, open a PR.",
    icon: "Repeat",
    tags: ["github", "ai", "claude", "loop"],
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 140 },
        data: {
          label: "GitHub: Issue labeled",
          params: { events: ["issues.labeled"] },
        },
      },
      {
        id: "n_loop",
        type: "action.github.runIssueLoop",
        typeVersion: 1,
        position: { x: 380, y: 140 },
        data: {
          label: "AI Issue→PR",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            issueNumber: "{{ $trigger.payload.body.issue.number }}",
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "n_trigger", target: "n_loop" }],
  })
}

// 4) Release: Conventional Commits — cron → changelog → draft release.
function releaseConventionalTemplate(): VisualWorkflow {
  return tmpl({
    id: "wf_builtin_gh_release_conventional",
    name: "[GitHub] Release: Conventional Commits",
    description:
      "Once a day, compute a Conventional-Commit-based semver bump since the last release and open a draft GitHub Release with auto-generated notes.",
    icon: "Tag",
    tags: ["github", "release", "cron", "conventional"],
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.cron",
        typeVersion: 1,
        position: { x: 80, y: 140 },
        data: { label: "Daily at 18:00", params: { cron: "0 18 * * *" } },
      },
      {
        id: "n_changelog",
        type: "action.github.generateChangelog",
        typeVersion: 1,
        position: { x: 380, y: 140 },
        data: {
          label: "Generate changelog",
          params: {
            repoFullName: "owner/repo",
            since: "v1.0.0",
            currentVersion: "1.0.0",
          },
        },
      },
      {
        id: "n_release",
        type: "action.github.createRelease",
        typeVersion: 1,
        position: { x: 720, y: 140 },
        data: {
          label: "Create draft Release",
          params: {
            repoFullName: "owner/repo",
            tag: "{{ $node['n_changelog'].out.nextVersion }}",
            body: "{{ $node['n_changelog'].out.markdown }}",
            draft: true,
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_changelog" },
      { id: "e2", source: "n_changelog", target: "n_release" },
    ],
  })
}

// 5) Release: continuous delivery — webhook on merge → push tag → release.
function releaseContinuousTemplate(): VisualWorkflow {
  return tmpl({
    id: "wf_builtin_gh_release_continuous",
    name: "[GitHub] Release: continuous",
    description:
      "When a PR merges to main, bump the version, push a tag, and create a Release. Use for projects that release on every merge.",
    icon: "GitMerge",
    tags: ["github", "release", "cd"],
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 140 },
        data: {
          label: "GitHub: PR merged",
          params: { events: ["pull_request.closed"] },
        },
      },
      {
        id: "n_changelog",
        type: "action.github.generateChangelog",
        typeVersion: 1,
        position: { x: 380, y: 140 },
        data: {
          label: "Generate changelog",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            since: "{{ $static.lastTag }}",
            currentVersion: "{{ $static.currentVersion }}",
          },
        },
      },
      {
        id: "n_tag",
        type: "action.github.pushTag",
        typeVersion: 1,
        position: { x: 720, y: 140 },
        data: {
          label: "Push tag",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            tag: "v{{ $node['n_changelog'].out.nextVersion }}",
            sha: "{{ $trigger.payload.body.pull_request.merge_commit_sha }}",
          },
        },
      },
      {
        id: "n_release",
        type: "action.github.createRelease",
        typeVersion: 1,
        position: { x: 1060, y: 140 },
        data: {
          label: "Publish Release",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            tag: "v{{ $node['n_changelog'].out.nextVersion }}",
            body: "{{ $node['n_changelog'].out.markdown }}",
            draft: false,
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_changelog" },
      { id: "e2", source: "n_changelog", target: "n_tag" },
      { id: "e3", source: "n_tag", target: "n_release" },
    ],
  })
}

// 6) Release: manual — manual trigger → release.
function releaseManualTemplate(): VisualWorkflow {
  return tmpl({
    id: "wf_builtin_gh_release_manual",
    name: "[GitHub] Release: manual",
    description: "Manual click → create a GitHub Release with parameters you fill in.",
    icon: "Tag",
    tags: ["github", "release", "manual"],
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 80, y: 140 },
        data: { label: "Click to release", params: {} },
      },
      {
        id: "n_release",
        type: "action.github.createRelease",
        typeVersion: 1,
        position: { x: 380, y: 140 },
        data: {
          label: "Create Release",
          params: {
            repoFullName: "owner/repo",
            tag: "v0.0.1",
            name: "Initial release",
            body: "Initial release notes.",
            draft: true,
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "n_trigger", target: "n_release" }],
  })
}

// 7) CI failure diagnosis — webhook on check_run.completed (failure) → AI diagnose → PR comment.
function ciFailureDiagnosisTemplate(): VisualWorkflow {
  return tmpl({
    id: "wf_builtin_gh_ci_diagnose",
    name: "[GitHub] CI failure diagnosis",
    description:
      "When a CI check fails, fetch the logs, ask the AI to diagnose the failure, and comment the analysis on the PR.",
    icon: "AlertTriangle",
    tags: ["github", "ai", "ci", "diagnose"],
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.github.webhook",
        typeVersion: 1,
        position: { x: 80, y: 140 },
        data: {
          label: "GitHub: check_run completed",
          params: { events: ["check_run.completed"] },
        },
      },
      {
        id: "n_ai",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 380, y: 140 },
        data: {
          label: "Diagnose",
          params: {
            systemPrompt:
              "You are a CI failure analyst. Read the check name + conclusion + logs and write a 3-bullet diagnosis of the likely root cause.",
            userPrompt:
              "Check: {{ $trigger.payload.body.check_run.name }} — {{ $trigger.payload.body.check_run.conclusion }}",
          },
        },
      },
      {
        id: "n_comment",
        type: "action.github.commentPr",
        typeVersion: 1,
        position: { x: 720, y: 140 },
        data: {
          label: "Comment diagnosis on PR",
          params: {
            repoFullName: "{{ $trigger.payload.body.repository.full_name }}",
            prNumber: "{{ $trigger.payload.body.check_run.pull_requests[0].number }}",
            body: "{{ $node['n_ai'].out.completion }}",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: "n_trigger", target: "n_ai" },
      { id: "e2", source: "n_ai", target: "n_comment" },
    ],
  })
}

export function buildGithubDeliveryTemplates(): VisualWorkflow[] {
  return [
    prAutoReviewTemplate(),
    issueTriageTemplate(),
    issuePrLoopTemplate(),
    releaseConventionalTemplate(),
    releaseContinuousTemplate(),
    releaseManualTemplate(),
    ciFailureDiagnosisTemplate(),
  ]
}
