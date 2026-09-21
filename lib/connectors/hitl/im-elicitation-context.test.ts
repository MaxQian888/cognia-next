/**
 * @jest-environment jsdom
 */
import {
  getImElicitationContext,
  registerImElicitationContext,
  unregisterImElicitationContext,
  __resetImElicitationForTesting,
  type ImElicitationContext,
} from "./im-elicitation-context"

function ctx(partial: Partial<ImElicitationContext> = {}): ImElicitationContext {
  return {
    sessionId: "sess-1",
    adapterId: "adp-1",
    conversationKey: "lark:adp-1:oc_1",
    conversationRef: { platform: "lark", adapterId: "adp-1", channelId: "oc_1" },
    ...partial,
  }
}

beforeEach(() => __resetImElicitationForTesting())

describe("im-elicitation-context", () => {
  it("returns undefined for an unknown session", () => {
    expect(getImElicitationContext("nope")).toBeUndefined()
  })

  it("returns a registered context", () => {
    const c = ctx()
    registerImElicitationContext(c)
    expect(getImElicitationContext("sess-1")).toBe(c)
  })

  it("unregisters via the returned callback", () => {
    const unregister = registerImElicitationContext(ctx())
    unregister()
    expect(getImElicitationContext("sess-1")).toBeUndefined()
    // Idempotent.
    unregister()
    expect(getImElicitationContext("sess-1")).toBeUndefined()
  })

  it("unregisters via the standalone function", () => {
    registerImElicitationContext(ctx())
    unregisterImElicitationContext("sess-1")
    expect(getImElicitationContext("sess-1")).toBeUndefined()
  })

  it("re-registration replaces the prior entry and the stale unregister is inert", () => {
    const first = ctx({ initiatorUserId: "u_a" })
    const second = ctx({ initiatorUserId: "u_b" })
    const unregFirst = registerImElicitationContext(first)
    registerImElicitationContext(second)
    unregFirst()
    // The stale cleanup must not clobber the newer registration.
    expect(getImElicitationContext("sess-1")).toBe(second)
  })

  it("an aborted signal makes the context unavailable", () => {
    const controller = new AbortController()
    registerImElicitationContext(ctx({ signal: controller.signal }))
    expect(getImElicitationContext("sess-1")).toBeDefined()
    controller.abort()
    expect(getImElicitationContext("sess-1")).toBeUndefined()
    // The dead entry is evicted, not lingering.
    expect(getImElicitationContext("sess-1")).toBeUndefined()
  })

  it("keys contexts per session", () => {
    registerImElicitationContext(ctx({ sessionId: "s1" }))
    registerImElicitationContext(ctx({ sessionId: "s2" }))
    expect(getImElicitationContext("s1")?.sessionId).toBe("s1")
    expect(getImElicitationContext("s2")?.sessionId).toBe("s2")
    unregisterImElicitationContext("s1")
    expect(getImElicitationContext("s1")).toBeUndefined()
    expect(getImElicitationContext("s2")).toBeDefined()
  })
})
