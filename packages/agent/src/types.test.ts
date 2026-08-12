import type {
  AgentTurnOutcome,
  ClientToolRegistration,
  CompactionResult,
  SessionState,
} from "./types"
import { isAgentWorkerManifestV1 } from "./types"

describe("public SDK types", () => {
  it("models compaction as a command with an optional live undo boundary", () => {
    const compacted: CompactionResult = {
      accepted: true,
      commandId: "compact-one",
      undoAvailable: false,
    }
    expect(compacted.boundaryId).toBeUndefined()
  })

  it("have serializable representative shapes", () => {
    const registration: ClientToolRegistration = {
      handlerId: "handler-1",
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      sideEffect: "none",
    }
    const outcome: AgentTurnOutcome = {
      status: "requires_action",
      suspended: { sessionId: "s", runId: "r", turnId: "t" },
    }
    const state: SessionState = { sessionId: "s", status: "idle" }

    expect(JSON.parse(JSON.stringify({ registration, outcome, state }))).toMatchObject({
      outcome: { status: "requires_action" },
      state: { status: "idle" },
    })
  })

  it("validates untrusted worker manifests at the placement boundary", () => {
    const manifest = {
      manifestVersion: 1,
      runtime: "builtin",
      models: ["test"],
      hardCapabilities: ["worker-dispatch-v1"],
      maxActiveTurns: 1,
      credentialProfileRefs: ["credential:test"],
      workspaceBindingRefs: ["repository:project:repo"],
      taskWorkspace: { enabled: true },
      sandbox: { capabilities: ["filesystem"] },
      platform: { os: "linux", arch: "arm64" },
    }
    expect(isAgentWorkerManifestV1(manifest)).toBe(true)
    expect(isAgentWorkerManifestV1({ ...manifest, maxActiveTurns: 0 })).toBe(false)
    expect(isAgentWorkerManifestV1({ ...manifest, workspaceBindingRefs: [""] })).toBe(false)
  })
})
