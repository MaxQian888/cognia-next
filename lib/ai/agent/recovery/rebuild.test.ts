import { validateCanonicalSession } from "@cognia/agent-config-types/canonical-session"

import { rebuildCanonicalSession } from "./rebuild"

it("rebuilds a provenance-marked session from trusted evidence with explicit gap losses", () => {
  const { session, loss } = rebuildCanonicalSession({
    canonicalSessionId: "canon:rebuild:s1",
    sourceRuntime: "claude-code",
    fidelity: "structured",
    title: "Rebuilt",
    nativeSessionId: "sdk-1",
    evidence: [
      { kind: "turn", turn: { turnId: "t1", role: "user", text: "q" } },
      { kind: "gap", note: "assistant reply lost with the crashed renderer" },
      { kind: "turn", turn: { turnId: "t2", role: "user", text: "again?" } },
    ],
  })
  expect(validateCanonicalSession(session)).toEqual([])
  expect(session.header.turnCount).toBe(2)
  expect(session.header.runtimeBinding).toEqual({ nativeSessionId: "sdk-1" })
  // The rebuild NEVER pretends to be the original.
  expect(loss.rebuilt).toBe(true)
  expect(loss.losses).toEqual([expect.objectContaining({ path: "evidence[1]", kind: "dropped" })])
})

it("rebuilds a minimal record without title or native binding", () => {
  const { session, loss } = rebuildCanonicalSession({
    canonicalSessionId: "canon:rebuild:min",
    sourceRuntime: "codex",
    fidelity: "summary-only",
    evidence: [],
  })
  expect(validateCanonicalSession(session)).toEqual([])
  expect(session.header.title).toBeUndefined()
  expect(session.header.runtimeBinding).toBeUndefined()
  expect(session.header.turnCount).toBe(0)
  expect(loss).toEqual({ fidelity: "summary-only", losses: [], rebuilt: true })
})
