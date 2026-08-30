import {
  MAX_HISTORY_EVIDENCE_PER_SESSION,
  __clearAllProjectHistoryEvidenceForTesting,
  clearProjectHistoryEvidence,
  drainProjectHistoryEvidence,
  recordProjectHistoryEvidence,
  type ProjectHistoryEvidence,
} from "./project-history-evidence-registry"

function evidence(id: string, over: Partial<ProjectHistoryEvidence> = {}): ProjectHistoryEvidence {
  return {
    id,
    kind: "message",
    sessionId: "s-1",
    messageId: id,
    title: "Earlier conversation",
    snippet: "we standardised on pnpm workspaces",
    createdAt: 1,
    ...over,
  }
}

afterEach(() => __clearAllProjectHistoryEvidenceForTesting())

it("hands back what a session recorded", () => {
  recordProjectHistoryEvidence("chat-1", [evidence("m-1")])
  expect(drainProjectHistoryEvidence("chat-1").map((e) => e.id)).toEqual(["m-1"])
})

it("accumulates across several calls within one turn", () => {
  recordProjectHistoryEvidence("chat-1", [evidence("m-1")])
  recordProjectHistoryEvidence("chat-1", [evidence("m-2")])
  expect(drainProjectHistoryEvidence("chat-1").map((e) => e.id)).toEqual(["m-1", "m-2"])
})

it("does not list the same hit twice when two queries both found it", () => {
  recordProjectHistoryEvidence("chat-1", [evidence("m-1", { title: "first" })])
  recordProjectHistoryEvidence("chat-1", [evidence("m-1", { title: "second" })])
  const drained = drainProjectHistoryEvidence("chat-1")
  expect(drained).toHaveLength(1)
  expect(drained[0].title).toBe("second")
})

it("CLEARS on drain, so turn N's evidence never rides on turn N+1", () => {
  recordProjectHistoryEvidence("chat-1", [evidence("m-1")])
  expect(drainProjectHistoryEvidence("chat-1")).toHaveLength(1)
  expect(drainProjectHistoryEvidence("chat-1")).toEqual([])
})

it("keeps sessions apart", () => {
  recordProjectHistoryEvidence("chat-1", [evidence("m-1")])
  recordProjectHistoryEvidence("chat-2", [evidence("m-2")])
  expect(drainProjectHistoryEvidence("chat-1").map((e) => e.id)).toEqual(["m-1"])
  expect(drainProjectHistoryEvidence("chat-2").map((e) => e.id)).toEqual(["m-2"])
})

it("drops the OLDEST entries past the cap, keeping the most recent search", () => {
  const many = Array.from({ length: MAX_HISTORY_EVIDENCE_PER_SESSION + 3 }, (_, i) =>
    evidence(`m-${i}`)
  )
  recordProjectHistoryEvidence("chat-1", many)
  const drained = drainProjectHistoryEvidence("chat-1")
  expect(drained).toHaveLength(MAX_HISTORY_EVIDENCE_PER_SESSION)
  expect(drained[0].id).toBe("m-3")
  expect(drained[drained.length - 1].id).toBe(`m-${MAX_HISTORY_EVIDENCE_PER_SESSION + 2}`)
})

it("lets an aborted turn throw its evidence away unread", () => {
  recordProjectHistoryEvidence("chat-1", [evidence("m-1")])
  clearProjectHistoryEvidence("chat-1")
  expect(drainProjectHistoryEvidence("chat-1")).toEqual([])
})

it("ignores an empty record and a blank session id", () => {
  recordProjectHistoryEvidence("chat-1", [])
  recordProjectHistoryEvidence("", [evidence("m-1")])
  expect(drainProjectHistoryEvidence("chat-1")).toEqual([])
  expect(drainProjectHistoryEvidence("")).toEqual([])
})
