import { SCM_HOST_COMMANDS, createScmHost, scmErrorCode } from "./host"

jest.mock("@/lib/task-workspace/user-action", () => ({
  approvalAwareTransport: { call: jest.fn(async () => "via-transport") },
}))

describe("createScmHost", () => {
  it("maps every method to its host command with named arguments", async () => {
    const call = jest.fn(async () => ({}))
    const host = createScmHost(call as never)
    await host.captureChangeset({ workspaceId: "ws", title: "t" })
    await host.recordChangesetReview("cs", { verdict: "approve" } as never)
    await host.approveChangeset("cs", "sha", "user")
    await host.analyzeIntegration(["a", "b"])
    await host.publishIntegration("int", "cand", ["unit"])
    await host.listChangesets()
    expect(call.mock.calls).toEqual([
      ["task_workspace_changeset_capture", { input: { workspaceId: "ws", title: "t" } }],
      [
        "task_workspace_changeset_record_review",
        { changesetId: "cs", review: { verdict: "approve" } },
      ],
      ["task_workspace_changeset_approve", { changesetId: "cs", headSha: "sha", approver: "user" }],
      ["task_workspace_integration_analyze", { changesetIds: ["a", "b"], targetRef: null }],
      [
        "task_workspace_integration_publish",
        { integrationId: "int", candidateSha: "cand", requiredChecks: ["unit"] },
      ],
      ["task_workspace_changeset_list", { filter: {} }],
    ])
  })

  it("goes through the approval-aware transport by default", async () => {
    await expect(createScmHost().getIntegration("int")).resolves.toBe("via-transport")
  })

  it("names every command once, in the task_workspace family", () => {
    const names = Object.values(SCM_HOST_COMMANDS)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names)
      expect(name).toMatch(/^task_workspace_(changeset|integration)_[a-z_]+$/)
  })
})

describe("scmErrorCode", () => {
  it("reads the code of a structured host error and nothing else", () => {
    expect(scmErrorCode({ code: "target_moved", message: "m", retryable: false })).toBe(
      "target_moved"
    )
    expect(scmErrorCode(new Error("target moved"))).toBeNull()
    expect(scmErrorCode("target moved")).toBeNull()
    expect(scmErrorCode({ code: 3 })).toBeNull()
    expect(scmErrorCode(null)).toBeNull()
  })
})
