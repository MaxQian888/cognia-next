import type { AcceptancePort, VerificationReport } from "@cognia/router-fusion"

import type { ScmHost } from "../host"
import type { AgentChangeset, ChangesetCheck, ChangesetReview } from "../types"
import type { ReviewAgentDeps } from "./review-agent"
import {
  approveChangeset,
  changesetRootForRevision,
  combineVerdict,
  requestChangesetChanges,
  requiredChecksFor,
  reviewChangeset,
} from "./review-changeset"
import { defaultReviewPolicy } from "./review-policy"

const HEAD = "h".repeat(40)

function changeset(overrides: Partial<AgentChangeset> = {}): AgentChangeset {
  return {
    changesetId: "cs-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    agentId: "agent-1",
    agentKind: "agent-team",
    ownerRef: "team-1",
    workspaceId: "ws-1",
    executionRoot: "/data/ws-1",
    repoCommonDir: "/repo/.git",
    sourceRoot: "/repo",
    targetRef: "refs/heads/main",
    baseSha: "b".repeat(40),
    headSha: HEAD,
    changeRef: "refs/cognia/changesets/cs-1",
    title: "Add validation",
    files: [
      {
        path: "src/a.ts",
        oldPath: null,
        status: "modified",
        insertions: 3,
        deletions: 1,
        binary: false,
        sensitive: false,
        excluded: false,
      },
    ],
    dependsOn: [],
    state: "ready",
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

function hostFor(initial: AgentChangeset) {
  let current = initial
  const host = {
    getChangeset: jest.fn(async () => current),
    markChangesetReady: jest.fn(async () => (current = { ...current, state: "ready" })),
    recordChangesetReview: jest.fn(async (_id: string, review: ChangesetReview) => {
      current = { ...current, review }
      return current
    }),
    recordChangesetCheck: jest.fn(async (_id: string, check: ChangesetCheck) => {
      current = { ...current, checks: [...current.checks, check] }
      return current
    }),
    approveChangeset: jest.fn(async (_id: string, headSha: string, approver: string) => {
      current = { ...current, approval: { headSha, approver, approvedAt: 1 } }
      return current
    }),
  } as unknown as jest.Mocked<ScmHost>
  return { host, current: () => current }
}

function agentDeps(reply: string | null): ReviewAgentDeps {
  return {
    loadDiff: jest.fn(async (_r, _b, _h, path) => ({
      path,
      oldContent: "",
      newContent: "",
      isBinary: false,
      language: null,
      hunks: [
        {
          header: "@@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          patch: "@@ -1 +1 @@\n-a\n+b\n",
          lines: [],
        },
      ],
    })),
    client: reply === null ? null : { complete: jest.fn(async () => reply) },
  }
}

const passingPort: AcceptancePort = {
  runProfile: async ({ revision }) => ({
    kind: "report",
    report: {
      schema_version: 1,
      report_id: "11111111-1111-4111-8111-111111111111",
      status: "passed",
      level: "runtime",
      revision,
      verifier_version: "t",
      artifact_refs: [],
      checks: [],
    } as unknown as VerificationReport,
  }),
}

const signal = new AbortController().signal
const noPolicy = jest.fn(async () => null)

describe("reviewChangeset", () => {
  it("records one head-bound review from the target policy, risk and agent", async () => {
    const { host } = hostFor(changeset())
    const result = await reviewChangeset("cs-1", {
      host,
      readBlob: noPolicy,
      agent: agentDeps("[]"),
      acceptancePort: null,
      signal,
      now: () => 7,
    })
    expect(noPolicy).toHaveBeenCalledWith("/repo", "refs/heads/main", ".cognia/workspace.json")
    expect(host.recordChangesetReview).toHaveBeenCalledWith("cs-1", {
      headSha: HEAD,
      verdict: "approve",
      reviewer: "agent",
      riskTier: "low",
      reasons: [],
      findings: [],
      requiresHumanApproval: false,
      recordedAt: 7,
    })
    expect(result.checks).toEqual([])
  })

  it("marks a draft ready before reviewing it", async () => {
    const { host } = hostFor(changeset({ state: "draft" }))
    await reviewChangeset("cs-1", {
      host,
      readBlob: noPolicy,
      agent: agentDeps("[]"),
      acceptancePort: null,
      signal,
    })
    expect(host.markChangesetReady).toHaveBeenCalledWith("cs-1")
  })

  it("refuses a changeset that is past review", async () => {
    const { host } = hostFor(changeset({ state: "queued" }))
    await expect(
      reviewChangeset("cs-1", {
        host,
        readBlob: noPolicy,
        agent: agentDeps("[]"),
        acceptancePort: null,
        signal,
      })
    ).rejects.toThrow("queued")
  })

  it("owes a human when the change touches a protected path", async () => {
    const { host } = hostFor(
      changeset({
        files: [
          {
            path: ".github/workflows/ci.yml",
            oldPath: null,
            status: "modified",
            insertions: 1,
            deletions: 0,
            binary: false,
            sensitive: false,
            excluded: false,
          },
        ],
      })
    )
    await reviewChangeset("cs-1", {
      host,
      readBlob: noPolicy,
      agent: agentDeps("[]"),
      acceptancePort: null,
      signal,
    })
    expect(host.recordChangesetReview.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        riskTier: "high",
        reasons: ["protectedPath:ci"],
        requiresHumanApproval: true,
      })
    )
  })

  it("records an unavailable agent as unavailable under a required reviewer", async () => {
    const { host } = hostFor(changeset())
    await reviewChangeset("cs-1", {
      host,
      readBlob: noPolicy,
      agent: agentDeps(null),
      acceptancePort: null,
      signal,
    })
    expect(host.recordChangesetReview.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        verdict: "unavailable",
        reasons: ["reviewAgentUnavailable:noModel"],
        requiresHumanApproval: true,
      })
    )
  })

  it("does not call the agent when the policy turns it off", async () => {
    const deps = agentDeps("[]")
    const { host } = hostFor(changeset())
    const readBlob = jest.fn(async () => JSON.stringify({ review: { reviewAgent: "off" } }))
    const result = await reviewChangeset("cs-1", {
      host,
      readBlob,
      agent: deps,
      acceptancePort: null,
      signal,
    })
    expect(deps.loadDiff).not.toHaveBeenCalled()
    expect(result.agent).toBeNull()
    expect(host.recordChangesetReview.mock.calls[0][1]).toEqual(
      expect.objectContaining({ verdict: "approve", reviewer: "deterministic" })
    )
  })

  it("fails closed to a human when the target's policy is invalid", async () => {
    const { host } = hostFor(changeset())
    const readBlob = jest.fn(async () => '{"review": {"humanApproval": "never"}}')
    const result = await reviewChangeset("cs-1", {
      host,
      readBlob,
      agent: agentDeps("[]"),
      acceptancePort: null,
      signal,
    })
    expect(result.policy).toBeNull()
    expect(host.recordChangesetReview.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        verdict: "unavailable",
        riskTier: "high",
        requiresHumanApproval: true,
        reasons: expect.arrayContaining([
          "reviewPolicyInvalid",
          "reviewPolicyInvalid:review_policy_human_approval_invalid",
        ]),
      })
    )
  })

  it("runs the changeset's and the policy's checks against the head's worktree", async () => {
    const { host } = hostFor(changeset({ requiredChecks: ["unit"] }))
    const readBlob = jest.fn(async () =>
      JSON.stringify({ review: { requiredChecks: ["lint", "unit"] } })
    )
    const runProfile = jest.fn(passingPort.runProfile)
    const result = await reviewChangeset("cs-1", {
      host,
      readBlob,
      agent: agentDeps("[]"),
      acceptancePort: { runProfile },
      signal,
    })
    expect(result.checks.map((check) => [check.profileId, check.outcome, check.headSha])).toEqual([
      ["unit", "passed", HEAD],
      ["lint", "passed", HEAD],
    ])
    expect(runProfile).toHaveBeenCalledWith(
      expect.objectContaining({ revision: HEAD, runId: "changeset:cs-1" })
    )
    expect(host.recordChangesetCheck).toHaveBeenCalledTimes(2)
  })

  it("records required checks inconclusive when no port is available", async () => {
    const { host } = hostFor(changeset({ requiredChecks: ["unit"] }))
    const result = await reviewChangeset("cs-1", {
      host,
      readBlob: noPolicy,
      agent: agentDeps("[]"),
      acceptancePort: null,
      signal,
    })
    expect(result.checks).toEqual([
      expect.objectContaining({ profileId: "unit", outcome: "inconclusive", headSha: HEAD }),
    ])
  })
})

describe("combineVerdict", () => {
  const policy = defaultReviewPolicy()
  const outcome = (verdict: "approve" | "requestChanges" | "unavailable") => ({
    verdict,
    headSha: HEAD,
    findings: [],
    reviewedFiles: [],
    skippedFiles: [],
    redacted: false,
  })

  it("lets an optional reviewer's absence through, but never a request for changes", () => {
    expect(combineVerdict({ ...policy, reviewAgent: "optional" }, outcome("unavailable"))).toEqual({
      verdict: "approve",
      reviewer: "deterministic",
    })
    expect(
      combineVerdict({ ...policy, reviewAgent: "optional" }, outcome("requestChanges")).verdict
    ).toBe("requestChanges")
    expect(combineVerdict(policy, outcome("unavailable")).verdict).toBe("unavailable")
    expect(combineVerdict(policy, null)).toEqual({ verdict: "approve", reviewer: "deterministic" })
  })
})

describe("requiredChecksFor", () => {
  it("unions the changeset's and the policy's profiles without duplicates", () => {
    expect(
      requiredChecksFor(
        { requiredChecks: ["unit"] },
        { ...defaultReviewPolicy(), requiredChecks: ["unit", "lint"] }
      )
    ).toEqual(["unit", "lint"])
    expect(requiredChecksFor({ requiredChecks: ["unit"] }, null)).toEqual(["unit"])
  })
})

describe("human decisions", () => {
  it("approves as the reviewer of record, keeping the automatic risk", async () => {
    const review: ChangesetReview = {
      headSha: HEAD,
      verdict: "unavailable",
      reviewer: "agent",
      riskTier: "high",
      reasons: ["protectedPath:ci"],
      findings: [],
      requiresHumanApproval: true,
      recordedAt: 1,
    }
    const { host, current } = hostFor(changeset({ review }))
    await approveChangeset(host, current(), "user", () => 9)
    expect(host.recordChangesetReview).toHaveBeenCalledWith("cs-1", {
      ...review,
      verdict: "approve",
      reviewer: "user",
      recordedAt: 9,
    })
    expect(host.approveChangeset).toHaveBeenCalledWith("cs-1", HEAD, "user")
    expect(current().approval?.headSha).toBe(HEAD)
  })

  it("requests changes with the person's note as a critical finding", async () => {
    const { host, current } = hostFor(changeset())
    await requestChangesetChanges(host, current(), "Split this into two changes", () => 3)
    expect(host.recordChangesetReview.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        verdict: "requestChanges",
        reviewer: "user",
        findings: [{ path: "", severity: "critical", note: "Split this into two changes" }],
      })
    )
  })
})

describe("changesetRootForRevision", () => {
  it("answers only the changeset's own head", async () => {
    const root = changesetRootForRevision({ headSha: HEAD, executionRoot: "/data/ws-1" })
    await expect(root(HEAD)).resolves.toBe("/data/ws-1")
    await expect(root("other")).resolves.toBeNull()
  })
})
