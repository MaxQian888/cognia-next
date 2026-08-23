import type { WorkflowHostCandidate } from "./workflow-placement"
import { selectWorkflowHost } from "./workflow-placement"

function candidate(
  ref: string,
  activeUnits: number,
  deploymentDigest: string,
  kind: WorkflowHostCandidate["kind"] = "remote-host"
): WorkflowHostCandidate {
  return {
    ref,
    kind,
    liveness: { online: true, lastSeenAt: 1_000, source: "socket" },
    provides: [],
    activeUnits,
    maxUnits: 4,
    deploymentDigest,
  }
}

describe("selectWorkflowHost", () => {
  it("uses colocated execution for legacy/default placement", () => {
    const selected = selectWorkflowHost({
      constraint: { mode: "colocate" },
      candidates: [
        candidate("host-cloud", 0, "digest-a"),
        candidate("local", 2, "digest-a", "local"),
      ],
      expectedDeploymentDigest: "digest-a",
      now: 1_000,
    })
    expect(selected.candidate.ref).toBe("local")
  })

  it("excludes a live host whose published deployment digest differs", () => {
    const selected = selectWorkflowHost({
      constraint: { mode: "auto" },
      candidates: [
        candidate("host-stale", 0, "digest-old"),
        candidate("local", 3, "digest-new", "local"),
      ],
      expectedDeploymentDigest: "digest-new",
      now: 1_000,
    })
    expect(selected.candidate.ref).toBe("local")
    expect(selected.considered).toContainEqual({
      ref: "host-stale",
      verdict: { ready: false, reason: "deployment_mismatch" },
    })
  })

  it("chooses the least-loaded compatible host with a stable ref tiebreak", () => {
    const selected = selectWorkflowHost({
      constraint: { mode: "auto" },
      candidates: [
        candidate("host-z", 1, "digest-a"),
        candidate("host-b", 0, "digest-a"),
        candidate("host-a", 0, "digest-a"),
        candidate("local", 2, "digest-a", "local"),
      ],
      expectedDeploymentDigest: "digest-a",
      now: 1_000,
    })
    expect(selected.candidate.ref).toBe("host-a")
  })

  it("reports an unreachable pinned Host as offline before comparing its digest", () => {
    const offline = candidate("host-offline", 0, "")
    offline.liveness = { online: false, lastSeenAt: 0, source: "request" }

    expect(() =>
      selectWorkflowHost({
        constraint: { mode: "pinned", ref: "host-offline" },
        candidates: [offline, candidate("local", 0, "digest-a", "local")],
        expectedDeploymentDigest: "digest-a",
        now: 1_000,
      })
    ).toThrow(
      expect.objectContaining({
        waiting: "pinned_candidate_unavailable",
        ref: "host-offline",
        reason: "offline",
      })
    )
  })
})
