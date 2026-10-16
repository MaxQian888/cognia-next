import { reconcileAgentBindings } from "./agent-bindings"

function harness(allowed: Record<string, boolean>, initiallyBound: string[] = []) {
  const bound = new Map<string, string>(initiallyBound.map((session) => [session, "kept"]))
  const asked: string[] = []
  return {
    bound,
    asked,
    deps: {
      driveAllowed: async (deviceId: string) => {
        asked.push(deviceId)
        return allowed[deviceId] === true
      },
      isBound: (sessionId: string) => bound.has(sessionId),
      bind: (sessionId: string, deviceId: string) => {
        bound.set(sessionId, deviceId)
      },
      unbind: (sessionId: string) => {
        bound.delete(sessionId)
      },
    },
  }
}

describe("reconcileAgentBindings", () => {
  it("binds conversations whose browser may be driven and drops those whose may not", async () => {
    const h = harness({ "browser-a": true, "browser-b": false }, ["s-old-b"])
    const result = await reconcileAgentBindings({
      ...h.deps,
      rows: [
        { sessionId: "s1", deviceId: "browser-a" },
        { sessionId: "s-old-b", deviceId: "browser-b" },
        { deviceId: "browser-a" },
      ],
    })
    expect(result).toEqual({ bound: 1, unbound: 1 })
    expect([...h.bound]).toEqual([["s1", "browser-a"]])
  })

  it("keeps an existing binding (and its starting tab) and asks once per browser", async () => {
    const h = harness({ "browser-a": true }, ["s1"])
    await reconcileAgentBindings({
      ...h.deps,
      rows: [
        { sessionId: "s1", deviceId: "browser-a" },
        { sessionId: "s2", deviceId: "browser-a" },
      ],
    })
    expect(h.bound.get("s1")).toBe("kept")
    expect(h.bound.get("s2")).toBe("browser-a")
    expect(h.asked).toEqual(["browser-a"])
  })

  it("lets the newest row decide a conversation started from two browsers", async () => {
    const h = harness({ "browser-a": false, "browser-b": true })
    await reconcileAgentBindings({
      ...h.deps,
      rows: [
        { sessionId: "s1", deviceId: "browser-b" },
        { sessionId: "s1", deviceId: "browser-a" },
      ],
    })
    expect(h.bound.get("s1")).toBe("browser-b")
  })
})
