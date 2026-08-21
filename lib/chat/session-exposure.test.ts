import type { ChatSession } from "@cognia/agent-config-types"
import { filterExposedSessions, isEmbeddedSession, isSessionExposed } from "./session-exposure"

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return { id: "s-1", title: "Session", createdAt: 1, updatedAt: 1, ...overrides }
}

describe("session exposure policy", () => {
  it.each([
    "main-list",
    "global-search",
    "plugin-enumeration",
    "external-connector",
    "standard-export",
  ] as const)("hides embedded sessions from %s", (channel) => {
    expect(
      isSessionExposed(session({ kind: "resource-workbench", visibility: "embedded" }), channel)
    ).toBe(false)
  })

  it("allows authenticated project sync and explicit resource export", () => {
    const embedded = session({ kind: "resource-workbench", visibility: "embedded" })
    expect(isSessionExposed(embedded, "authenticated-project-sync")).toBe(true)
    expect(isSessionExposed(embedded, "resource-export")).toBe(true)
  })

  it("keeps legacy workflow and subagent sessions hidden in ordinary surfaces", () => {
    expect(isSessionExposed(session({ kind: "workflow-editor" }), "main-list")).toBe(false)
    expect(isSessionExposed(session({ kind: "subagent" }), "global-search")).toBe(false)
    expect(isSessionExposed(session({ kind: "direct" }), "main-list")).toBe(true)
  })

  it("recognizes visibility-only embeddings and filters ordinary lists", () => {
    const ordinary = session({ id: "ordinary", kind: "direct" })
    const embedded = session({ id: "embedded", visibility: "embedded" })
    expect(isEmbeddedSession(embedded)).toBe(true)
    expect(isEmbeddedSession(ordinary)).toBe(false)
    expect(filterExposedSessions([ordinary, embedded], "main-list")).toEqual([ordinary])
  })
})

describe("imported subagent transcripts (ADR-0062)", () => {
  const subagent = session({ kind: "subagent" })

  it.each(["main-list", "global-search", "plugin-enumeration", "external-connector"] as const)(
    "stays hidden from %s — drill-in from a parent turn is still the only way in",
    (channel) => {
      expect(isSessionExposed(subagent, channel)).toBe(false)
    }
  )

  it.each(["standard-export", "authenticated-project-sync", "resource-export"] as const)(
    "rides along on %s so the parent's drill-in link is not orphaned",
    (channel) => {
      // The parent turn IS exported/synced and its
      // `SubagentPart.nestedSessionId` points here. Excluding the target while
      // keeping the link is what turned a restore into a dead button.
      expect(isSessionExposed(subagent, channel)).toBe(true)
    }
  )

  it("does not widen the other embedded kinds", () => {
    const workbench = session({ kind: "resource-workbench", visibility: "embedded" })
    expect(isSessionExposed(workbench, "standard-export")).toBe(false)
  })
})
