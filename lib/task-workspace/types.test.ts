import type {
  ResourceChange,
  ResourceEvent,
  ResourceTrackingPolicy,
  TaskResourceManifest,
  WorkspaceEnvironmentSummary,
} from "./types"

describe("task workspace resource tracking contract", () => {
  it("represents source and generated records without generated content capture", () => {
    const policy: ResourceTrackingPolicy = {
      generatedOutputRoots: ["dist"],
      autoDetect: true,
    }
    const generated = {
      runId: "run-1",
      path: "dist/app.js",
      oldPath: null,
      kind: "created",
      origin: "agent",
      agentId: "agent-1",
      mediaType: "application/javascript",
      size: 42,
      hash: null,
      beforeHash: null,
      insertions: null,
      deletions: null,
      binary: false,
      resourceKind: "file",
      beforeMode: null,
      afterMode: null,
      sensitive: false,
      revision: 1,
      captureClass: "generated",
      contentCaptured: false,
    } satisfies ResourceChange
    const event = {
      eventId: "event-1",
      taskId: "task-1",
      runId: "run-1",
      seq: 1,
      observedAt: 1,
      kind: "created",
      path: generated.path,
      oldPath: null,
      captureClass: "generated",
      origin: "agent",
      agentId: "agent-1",
      evidence: "watcher",
      toolCallId: null,
      mediaType: generated.mediaType,
      size: generated.size,
      resourceKind: "file",
      sensitive: false,
      provisional: true,
      overflow: false,
      resyncRequired: false,
      reconciled: false,
    } satisfies ResourceEvent
    const manifest = {
      schemaVersion: 1,
      exportedAt: 1,
      task: {} as TaskResourceManifest["task"],
      runs: [],
      resources: [generated],
      events: [event],
      summaries: [],
    } satisfies TaskResourceManifest

    expect(policy.generatedOutputRoots).toEqual(["dist"])
    expect(manifest.resources[0]).toEqual(
      expect.objectContaining({ hash: null, contentCaptured: false })
    )
  })
})

describe("workspace environment inventory contract", () => {
  it("keeps ownership and allowed actions explicit at the transport boundary", () => {
    const environment = {
      environmentId: "managed:ws-1",
      workspaceId: "ws-1",
      path: "/managed/ws-1",
      sourceRoot: "/repo",
      ownership: "managed",
      ownerType: "session",
      ownerRef: "session-1",
      state: "active",
      branch: null,
      head: "abc123",
      locked: true,
      lockReason: "cognia:managed:ws-1",
      prunable: false,
      pruneReason: null,
      base: { kind: "remoteDefault" },
      pinned: false,
      allowedActions: ["open", "createBranchHere"],
    } satisfies WorkspaceEnvironmentSummary

    expect(environment.ownership).toBe("managed")
    expect(environment.ownerType).toBe("session")
    expect(environment.allowedActions).toContain("createBranchHere")
  })
})
