import {
  delegateAcceptanceFrom,
  delegateApprovalFrom,
  delegatePatchView,
  delegateProgressFrom,
  loadDelegateReview,
  parseDelegatePatchDocument,
  type DelegateApprovalRecord,
  type DelegatePatchSetRecord,
  type DelegateReviewSources,
  type DelegateRunEventRecord,
} from "./delegate-review-model"

function phase(step: string, extra: Record<string, unknown> = {}): DelegateRunEventRecord {
  return { type: "phase.changed", payload: { phase: "delegate", step, ...extra } }
}

function patchSet(over: Partial<DelegatePatchSetRecord> = {}): DelegatePatchSetRecord {
  return {
    patchSetId: "patch-1",
    runId: "run-1",
    baseRevision: "git:abc",
    resultRevision: "staged:def",
    patchSha256: "a".repeat(64),
    patchArtifactId: "artifact-1",
    fileCount: 1,
    paths: ["src/a.ts"],
    delivery: "patch_only",
    appliedRevision: null,
    appliedAt: null,
    createdAt: 10,
    ...over,
  }
}

function approval(over: Partial<DelegateApprovalRecord> = {}): DelegateApprovalRecord {
  return {
    id: "approval-1",
    kind: "workspace_apply",
    requestDigest: "d".repeat(64),
    revision: "git:abc",
    status: "pending",
    summary: {
      paths: ["src/a.ts"],
      fileCount: 1,
      patchSha256: "a".repeat(64),
      patchArtifactId: "artifact-1",
    },
    createdAt: 20,
    decidedAt: null,
    ...over,
  }
}

const PATCH_DOCUMENT = JSON.stringify({
  format: "cognia-delegate-patch-1",
  base_revision: "git:abc",
  files: [
    { path: "src/a.ts", action: "write", content: "next\n", content_sha256: "b".repeat(64) },
    { path: "src/gone.ts", action: "delete", content: null, content_sha256: null },
  ],
})

function sources(over: Partial<DelegateReviewSources> = {}): DelegateReviewSources {
  return {
    run: { runId: "run-1", mode: "delegate", status: "waiting_for_approval" },
    events: [],
    patchSets: [],
    approvals: [],
    readArtifact: async () => null,
    acceptance: null,
    comparison: null,
    ...over,
  }
}

describe("delegateProgressFrom", () => {
  it("counts turns, attempts, repairs and takeovers from the run's own journal", () => {
    const progress = delegateProgressFrom([
      { type: "run.started", payload: {} },
      { type: "phase.changed", payload: { phase: "panel", step: "candidates" } },
      phase("planned", { subtasks: 2 }),
      phase("attempt", { kind: "work" }),
      phase("turn", {}),
      phase("turn", {}),
      phase("attempt_result", { tool_operations: 4 }),
      phase("attempt", { kind: "repair" }),
      phase("turn", {}),
      phase("attempt_result", { tool_operations: 1 }),
      phase("attempt", { kind: "takeover" }),
      phase("approval_resolved", { kind: "scope_expansion", decision: "approved" }),
      phase("delivered", { delivery: "workspace_updated", revision: "git:zzz" }),
    ])
    expect(progress).toMatchObject({
      subtasks: 2,
      attempts: 3,
      turns: 3,
      toolOperations: 5,
      repairs: 1,
      takeovers: 1,
      scopeExpansions: 1,
      delivery: "workspace_updated",
      deliveredRevision: "git:zzz",
      empty: false,
    })
  })

  it("reports an empty journal as empty rather than as zero work", () => {
    expect(delegateProgressFrom([{ type: "run.started", payload: {} }]).empty).toBe(true)
  })
})

describe("delegateAcceptanceFrom", () => {
  const report = {
    status: "passed",
    level: "tool_verified",
    revision: "staged:def",
    verifier_version: "code-acceptance-1",
    checks: [
      {
        check_id: "sandbox",
        kind: "sandbox",
        status: "passed",
        summary: "tier=os",
        executed_by: "runtime",
      },
    ],
  }

  it("shows the tier the report attested", () => {
    const view = delegateAcceptanceFrom(report, {
      tier: "os",
      exit: "0",
      report: "junit.xml",
      discovered: 12,
      passed: 12,
      failed: 0,
      errored: 0,
      skipped: 0,
    })
    expect(view.tier).toBe("os")
    expect(view.discovered).toBe(12)
    expect(view.hasModelCheck).toBe(false)
  })

  it("leaves the tier null when nothing attested one, and never invents a count", () => {
    const view = delegateAcceptanceFrom(report, null)
    expect(view.tier).toBeNull()
    expect(view.discovered).toBeNull()
    expect(view.failed).toBeNull()
  })

  it("[ACC:DEL-01] marks a check a model executed, so a claim is never read as evidence", () => {
    const view = delegateAcceptanceFrom(
      {
        ...report,
        checks: [
          {
            check_id: "worker_claim",
            kind: "claim",
            status: "passed",
            summary: "all tests pass",
            executed_by: "model",
          },
        ],
      },
      null
    )
    expect(view.hasModelCheck).toBe(true)
    expect(view.checks[0]!.executedBy).toBe("model")
  })

  it("refuses an unknown status rather than showing it as passed", () => {
    const view = delegateAcceptanceFrom({ ...report, status: "green" }, null)
    expect(view.status).toBe("inconclusive")
  })
})

describe("parseDelegatePatchDocument", () => {
  it("reads the contract's whole-file writes and deletes", () => {
    const parsed = parseDelegatePatchDocument(PATCH_DOCUMENT)
    expect(parsed?.base_revision).toBe("git:abc")
    expect(parsed?.files).toEqual([
      { path: "src/a.ts", action: "write", content: "next\n" },
      { path: "src/gone.ts", action: "delete", content: null },
    ])
  })

  it("answers null for a document it cannot trust", () => {
    expect(parseDelegatePatchDocument(null)).toBeNull()
    expect(parseDelegatePatchDocument("{")).toBeNull()
    expect(parseDelegatePatchDocument(JSON.stringify({ files: [] }))).toBeNull()
  })
})

describe("delegatePatchView", () => {
  it("pairs each file with the workspace's copy and says which revision that is", async () => {
    const view = await delegatePatchView(patchSet(), PATCH_DOCUMENT, {
      revision: "git:abc",
      read: async (path) =>
        path === "src/a.ts" ? { state: "read", content: "previous\n" } : { state: "absent" },
    })
    expect(view.comparedAtBase).toBe(true)
    expect(view.files[0]).toMatchObject({
      path: "src/a.ts",
      action: "write",
      baseContent: "previous\n",
      baseState: "read",
      newContent: "next\n",
      unchanged: false,
    })
    expect(view.files[1]).toMatchObject({ action: "delete", newContent: null })
  })

  it("says the comparison is not against the base when the workspace moved", async () => {
    const view = await delegatePatchView(patchSet(), PATCH_DOCUMENT, {
      revision: "git:moved",
      read: async () => ({ state: "unavailable" }),
    })
    expect(view.comparedAtBase).toBe(false)
    expect(view.files.every((file) => file.baseState === "unavailable")).toBe(true)
  })

  it("keeps the index row when the patch document has expired", async () => {
    const view = await delegatePatchView(patchSet(), null, null)
    expect(view.document).toBeNull()
    expect(view.files).toHaveLength(0)
    expect(view.paths).toEqual(["src/a.ts"])
  })

  it("marks a file the workspace already matches", async () => {
    const view = await delegatePatchView(patchSet(), PATCH_DOCUMENT, {
      revision: "git:abc",
      read: async () => ({ state: "read", content: "next\n" }),
    })
    expect(view.files[0]!.unchanged).toBe(true)
  })
})

describe("loadDelegateReview", () => {
  it("[ACC:OFF-01] loads nothing while Router + Fusion is off", async () => {
    const readSources = jest.fn()
    const state = await loadDelegateReview("run-1", {
      enabled: async () => false,
      readSources,
    })
    expect(state).toEqual({ state: "off" })
    expect(readSources).not.toHaveBeenCalled()
  })

  it("answers not-delegate for a run of another mode", async () => {
    const state = await loadDelegateReview("run-1", {
      enabled: async () => true,
      readSources: async () =>
        sources({ run: { runId: "run-1", mode: "panel", status: "succeeded" } }),
    })
    expect(state).toEqual({ state: "not-delegate" })
  })

  it("reports an unreadable record instead of an empty review", async () => {
    const state = await loadDelegateReview("run-1", {
      enabled: async () => true,
      readSources: async () => {
        throw new Error("the fusion database is locked")
      },
    })
    expect(state).toEqual({ state: "unavailable", reason: "the fusion database is locked" })
  })

  it("[ACC:API-08] surfaces the newest pending approval, with the digest it is bound to", async () => {
    const state = await loadDelegateReview("run-1", {
      enabled: async () => true,
      readSources: async () =>
        sources({
          patchSets: [patchSet()],
          approvals: [
            approval({
              id: "approval-0",
              status: "approved",
              decidedAt: 15,
              kind: "scope_expansion",
            }),
            approval(),
          ],
          readArtifact: async (id) => (id === "artifact-1" ? PATCH_DOCUMENT : null),
          events: [phase("planned", { subtasks: 1 }), phase("turn", {})],
        }),
    })
    expect(state.state).toBe("ready")
    if (state.state !== "ready") return
    expect(state.review.pendingApproval).toMatchObject({
      id: "approval-1",
      kind: "workspace_apply",
      requestDigest: "d".repeat(64),
      revision: "git:abc",
    })
    expect(state.review.approvals).toHaveLength(2)
    expect(state.review.patch?.files).toHaveLength(2)
    expect(state.review.progress.turns).toBe(1)
  })

  it("keeps the review when the patch artifact can no longer be read", async () => {
    const state = await loadDelegateReview("run-1", {
      enabled: async () => true,
      readSources: async () =>
        sources({
          patchSets: [patchSet()],
          readArtifact: async () => {
            throw new Error("content expired")
          },
        }),
    })
    expect(state.state).toBe("ready")
    if (state.state !== "ready") return
    expect(state.review.patch?.document).toBeNull()
  })
})

describe("delegateApprovalFrom", () => {
  it("carries the paths and counts a decision needs, and nothing else", () => {
    expect(delegateApprovalFrom(approval())).toEqual({
      id: "approval-1",
      kind: "workspace_apply",
      status: "pending",
      requestDigest: "d".repeat(64),
      revision: "git:abc",
      paths: ["src/a.ts"],
      fileCount: 1,
      createdAt: 20,
      decidedAt: null,
    })
  })
})
