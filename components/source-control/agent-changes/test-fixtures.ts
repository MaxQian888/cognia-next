import type { ScmHost } from "@/lib/scm/host"
import type { AgentChangeset, ChangesetReview, IntegrationRun } from "@/lib/scm/types"

export function makeChangeset(overrides: Partial<AgentChangeset> = {}): AgentChangeset {
  return {
    changesetId: "cs-1",
    runId: null,
    taskId: null,
    sessionId: null,
    agentId: "agent-1",
    agentKind: "team",
    ownerRef: null,
    workspaceId: "ws-1",
    executionRoot: "/worktrees/1",
    sourceRoot: "/repo",
    repoCommonDir: "/repo/.git",
    targetRef: "refs/heads/main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changeRef: "refs/cognia/changesets/cs-1",
    title: "Add validation",
    state: "ready",
    files: [
      {
        path: "src/a.ts",
        oldPath: null,
        status: "modified",
        insertions: 4,
        deletions: 2,
        binary: false,
        sensitive: false,
        excluded: false,
      },
    ],
    dependsOn: [],
    review: null,
    checks: [],
    requiredChecks: [],
    approval: null,
    integrationId: null,
    mergedSha: null,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

export function makeReview(overrides: Partial<ChangesetReview> = {}): ChangesetReview {
  return {
    headSha: "b".repeat(40),
    verdict: "approve",
    reviewer: "agent",
    riskTier: "high",
    reasons: ["protectedPath:ci"],
    findings: [],
    requiresHumanApproval: true,
    recordedAt: 0,
    ...overrides,
  }
}

export function makeIntegration(overrides: Partial<IntegrationRun> = {}): IntegrationRun {
  return {
    integrationId: "run-1",
    repoCommonDir: "/repo/.git",
    targetRef: "refs/heads/main",
    strategy: "merge",
    onConflict: "skip",
    expectedOldSha: "a".repeat(40),
    candidateSha: "c".repeat(40),
    resultSha: null,
    state: "prepared",
    items: [
      {
        changesetId: "cs-1",
        headSha: "b".repeat(40),
        outcome: "merged",
        conflictFiles: [],
        commitSha: "c".repeat(40),
      },
    ],
    worktreePath: "/integration",
    attempt: 1,
    opLog: [],
    checks: [],
    requiredChecks: [],
    requestedChecks: [],
    error: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

export function makeHost(changesets = [makeChangeset()], integrations: IntegrationRun[] = []) {
  return {
    listChangesets: jest.fn(async () => changesets),
    listIntegrations: jest.fn(async () => integrations),
    changesetEligibility: jest.fn(async () => ({
      eligible: false,
      gaps: [{ kind: "missingHumanApproval" as const }],
    })),
    getChangeset: jest.fn(
      async (id: string) => changesets.find((item) => item.changesetId === id) ?? null
    ),
    recordChangesetReview: jest.fn(async (id: string, review: ChangesetReview) => ({
      ...changesets.find((item) => item.changesetId === id)!,
      review,
    })),
    approveChangeset: jest.fn(async (id: string) =>
      changesets.find((item) => item.changesetId === id)!
    ),
    abandonChangeset: jest.fn(async (id: string) =>
      changesets.find((item) => item.changesetId === id)!
    ),
    analyzeIntegration: jest.fn(async (ids: string[]) => ({
      order: ids,
      predictedConflicts: [],
      overlaps: [],
      prediction: "mergeTree" as const,
      cycles: [],
    })),
    rollbackIntegration: jest.fn(async () => makeIntegration({ state: "rolledBack" })),
    abortIntegration: jest.fn(async () => makeIntegration({ state: "aborted" })),
  } as unknown as jest.Mocked<ScmHost>
}
