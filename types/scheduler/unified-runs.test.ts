import {
  runApprovalRequest,
  toRunStatusPill,
  type UnifiedExecutionRun,
  type UnifiedRunStatus,
} from "./unified-runs"

describe("toRunStatusPill", () => {
  it("passes through every status that the workflow pill already understands", () => {
    const passthrough: UnifiedRunStatus[] = ["running", "succeeded", "failed", "cancelled"]
    for (const status of passthrough) {
      expect(toRunStatusPill(status)).toBe(status)
    }
  })

  it("collapses 'skipped' to 'cancelled' (no skip glyph in RunStatusPill)", () => {
    expect(toRunStatusPill("skipped")).toBe("cancelled")
  })
})

describe("runApprovalRequest", () => {
  const base: UnifiedExecutionRun = {
    unifiedId: "app:exec-1",
    kind: "app",
    itemUnifiedId: "app:task-1",
    itemName: "Nightly",
    status: "failed",
    startedAt: 1,
    terminalReason: "needs-approval",
    origin: { tableName: "scheduledTaskRuns", nativeId: "exec-1" },
  }

  it("names each refused tool once and the roots the run was restricted for", () => {
    expect(
      runApprovalRequest({
        ...base,
        result: {
          status: "needs_approval",
          needsApproval: [
            { requestId: "r1", toolName: "Bash" },
            { requestId: "r2", toolName: "Edit" },
            { requestId: "r3", toolName: "Bash" },
          ],
          workspaceTrust: { restricted: true, untrustedRoots: ["/repo", "/docs"] },
        },
      })
    ).toEqual({ tools: ["Bash", "Edit"], untrustedRoots: ["/repo", "/docs"], unverified: false })
  })

  it("keeps an unverified trust restriction apart from an untrusted one", () => {
    expect(
      runApprovalRequest({
        ...base,
        result: {
          needsApproval: [],
          workspaceTrust: { restricted: true, untrustedRoots: ["/repo"], unverified: true },
        },
      })
    ).toEqual({ tools: [], untrustedRoots: ["/repo"], unverified: true })
  })

  it("still answers for a row whose result was not kept", () => {
    expect(runApprovalRequest(base)).toEqual({ tools: [], untrustedRoots: [], unverified: false })
  })

  it("ignores malformed denial and root entries", () => {
    expect(
      runApprovalRequest({
        ...base,
        result: {
          needsApproval: [null, "Bash", { toolName: 3 }, { toolName: "" }, { toolName: "Write" }],
          workspaceTrust: { untrustedRoots: [7, "", "/repo"] },
        },
      })
    ).toEqual({ tools: ["Write"], untrustedRoots: ["/repo"], unverified: false })
  })

  it("is null for any other outcome", () => {
    expect(runApprovalRequest({ ...base, terminalReason: "executor-failure" })).toBeNull()
    expect(runApprovalRequest({ ...base, terminalReason: undefined })).toBeNull()
    // A terminal reason is only read off a run that actually failed.
    expect(runApprovalRequest({ ...base, status: "succeeded" })).toBeNull()
  })
})
