/** @jest-environment jsdom */
import { useCreatorStore } from "./creator-store"

const NOW = 1_700_000_000_000

function reset() {
  useCreatorStore.setState({
    authoringRoot: null,
    activeRunId: null,
    artifactKind: "plugin",
    approvedAdditions: [],
  })
}

beforeEach(reset)

describe("useCreatorStore", () => {
  it("has the documented defaults", () => {
    const state = useCreatorStore.getState()
    expect(state.authoringRoot).toBeNull()
    expect(state.activeRunId).toBeNull()
    expect(state.artifactKind).toBe("plugin")
    expect(state.approvedAdditions).toEqual([])
  })

  it("grants a valid authoring root", () => {
    const result = useCreatorStore.getState().grantAuthoringRoot({
      path: "/work/authoring",
      now: NOW,
    })
    expect(result).toEqual({ ok: true })
    expect(useCreatorStore.getState().authoringRoot).toEqual({
      path: "/work/authoring",
      label: "authoring",
      origin: "selected",
      grantedAt: NOW,
    })
  })

  it("refuses an invalid root and leaves the previous grant intact", () => {
    const store = useCreatorStore.getState()
    store.grantAuthoringRoot({ path: "/work/authoring", now: NOW })
    const result = useCreatorStore.getState().grantAuthoringRoot({ path: "/", now: NOW })

    expect(result).toEqual({ ok: false, reason: "filesystem-root" })
    expect(useCreatorStore.getState().authoringRoot?.path).toBe("/work/authoring")
  })

  // Approvals are scoped to an artifact in a specific root; carrying them into
  // a different root would approve capabilities the user never saw there.
  it("clears approvals when the root changes", () => {
    const store = useCreatorStore.getState()
    store.grantAuthoringRoot({ path: "/work/a", now: NOW })
    useCreatorStore.getState().approveAdditions(["fs.write"])
    expect(useCreatorStore.getState().approvedAdditions).toEqual(["fs.write"])

    useCreatorStore.getState().grantAuthoringRoot({ path: "/work/b", now: NOW })
    expect(useCreatorStore.getState().approvedAdditions).toEqual([])
  })

  it("revoking the root ends the run and clears approvals", () => {
    const store = useCreatorStore.getState()
    store.grantAuthoringRoot({ path: "/work/a", now: NOW })
    useCreatorStore.getState().startRun("creator_1")
    useCreatorStore.getState().approveAdditions(["fs.write"])

    useCreatorStore.getState().revokeAuthoringRoot()
    const state = useCreatorStore.getState()
    expect(state.authoringRoot).toBeNull()
    expect(state.activeRunId).toBeNull()
    expect(state.approvedAdditions).toEqual([])
  })

  it("starting a run clears approvals from the previous run", () => {
    useCreatorStore.getState().approveAdditions(["fs.write"])
    useCreatorStore.getState().startRun("creator_2")
    expect(useCreatorStore.getState().approvedAdditions).toEqual([])
    expect(useCreatorStore.getState().activeRunId).toBe("creator_2")
  })

  it("ending a run keeps the root granted", () => {
    const store = useCreatorStore.getState()
    store.grantAuthoringRoot({ path: "/work/a", now: NOW })
    useCreatorStore.getState().startRun("creator_3")
    useCreatorStore.getState().endRun()

    expect(useCreatorStore.getState().activeRunId).toBeNull()
    expect(useCreatorStore.getState().authoringRoot).not.toBeNull()
  })

  it("normalizes and deduplicates approved capabilities", () => {
    useCreatorStore.getState().approveAdditions([" net.fetch ", "fs.write", "net.fetch"])
    expect(useCreatorStore.getState().approvedAdditions).toEqual(["fs.write", "net.fetch"])
  })

  it("clears approvals on request", () => {
    useCreatorStore.getState().approveAdditions(["fs.write"])
    useCreatorStore.getState().clearApprovals()
    expect(useCreatorStore.getState().approvedAdditions).toEqual([])
  })

  it("sets the artifact kind", () => {
    useCreatorStore.getState().setArtifactKind("visual-workflow")
    expect(useCreatorStore.getState().artifactKind).toBe("visual-workflow")
  })

  it("persists the grant but not the approvals", () => {
    const store = useCreatorStore.getState()
    store.grantAuthoringRoot({ path: "/work/authoring", now: NOW })
    useCreatorStore.getState().approveAdditions(["fs.write"])

    const stored = window.localStorage.getItem("cognia-next.creator")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    expect(parsed.state.authoringRoot.path).toBe("/work/authoring")
    // A dormant tab must not resume straight into a write on a stale approval.
    expect(parsed.state.approvedAdditions).toBeUndefined()
    expect(parsed.version).toBe(1)
  })
})
