import { isReferenceable, referenceCandidateFor } from "./referenceable"
import type { GlobalSearchItem, GlobalSearchKind } from "./types"

function item(over: Partial<GlobalSearchItem> = {}): GlobalSearchItem {
  return {
    id: "session:s_1",
    kind: "session",
    title: "Restacking",
    score: 1,
    action: { type: "open-session", sessionId: "s_1" },
    ...over,
  } as GlobalSearchItem
}

describe("referenceCandidateFor", () => {
  it("turns a conversation hit into a session reference", () => {
    expect(referenceCandidateFor(item())).toMatchObject({
      entityKind: "session",
      id: "s_1",
      title: "Restacking",
    })
  })

  // The granularity ⌘K has always been able to FIND and never able to hand over.
  it("turns a message hit into a message reference addressed by both halves", () => {
    const candidate = referenceCandidateFor(
      item({
        id: "message:m_1",
        kind: "message",
        title: "Restacking",
        subtitle: "run /stack restack",
        extra: { sessionId: "s_1" },
      })
    )
    expect(candidate).toMatchObject({ entityKind: "message", id: "s_1#m_1" })
    expect(candidate?.href).toBe("/?session=s_1&message=m_1")
    expect(candidate?.subtitle).toBe("run /stack restack")
  })

  // A message id alone cannot address a reference; without the conversation the
  // candidate would be unresolvable, so the row must not offer the control.
  it("refuses a message hit with no conversation on it", () => {
    expect(referenceCandidateFor(item({ id: "message:m_1", kind: "message" }))).toBeNull()
  })

  it("carries a memory and an issue by their own id", () => {
    expect(referenceCandidateFor(item({ id: "memory:mem_1", kind: "memory" }))).toMatchObject({
      entityKind: "memory",
      id: "mem_1",
    })
    expect(referenceCandidateFor(item({ id: "issue:iss_1", kind: "issue" }))).toMatchObject({
      entityKind: "issue",
      id: "iss_1",
    })
  })

  // The mention registry drew the line at "has a body a model can read"; a
  // workflow is a thing you RUN.
  it.each<GlobalSearchKind>(["workflow", "skill", "settings", "navigation", "device", "template"])(
    "does not offer to reference a %s",
    (kind) => {
      expect(referenceCandidateFor(item({ id: `${kind}:x`, kind }))).toBeNull()
    }
  )

  it("refuses a row whose id carries no record id", () => {
    expect(referenceCandidateFor(item({ id: "session:" }))).toBeNull()
  })

  it("agrees with the cheap predicate the row renderer uses", () => {
    expect(isReferenceable(item())).toBe(true)
    expect(isReferenceable(item({ id: "workflow:w", kind: "workflow" }))).toBe(false)
  })
})
