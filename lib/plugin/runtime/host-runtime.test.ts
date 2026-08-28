import {
  PluginHostRuntimeUnavailableError,
  __resetPluginHostRuntimesForTesting,
  clearSessionHostRuntime,
  disableAmbientHostRuntime,
  enableAmbientHostRuntime,
  hasSessionHostRuntime,
  registerSessionHostRuntime,
  resolvePluginHostRuntime,
  setAmbientHostRuntime,
  type PluginHostRuntime,
} from "./host-runtime"

function stubRuntime(label: string): PluginHostRuntime {
  return {
    runHostTool: async () => ({ ok: true, label }),
    chat: async function* () {},
    embed: async () => [],
    getDefaultProvider: () => label,
    getDefaultModel: () => `${label}-model`,
  }
}

afterEach(() => {
  __resetPluginHostRuntimesForTesting()
})

describe("ambient resolution", () => {
  it("uses the installed ambient runtime when no session is bound", () => {
    setAmbientHostRuntime(() => stubRuntime("ambient"))
    expect(resolvePluginHostRuntime({ pluginId: "p" }).getDefaultProvider()).toBe("ambient")
  })

  it("passes the request through to the factory", () => {
    const seen: unknown[] = []
    setAmbientHostRuntime((request) => {
      seen.push(request)
      return stubRuntime("ambient")
    })
    resolvePluginHostRuntime({ pluginId: "p", sessionId: "s", messageId: "m" })
    expect(seen).toEqual([{ pluginId: "p", sessionId: "s", messageId: "m" }])
  })
})

describe("session bindings", () => {
  it("prefers a session binding over the ambient runtime", () => {
    setAmbientHostRuntime(() => stubRuntime("ambient"))
    registerSessionHostRuntime("s1", () => stubRuntime("session-1"))
    expect(resolvePluginHostRuntime({ pluginId: "p", sessionId: "s1" }).getDefaultProvider()).toBe(
      "session-1"
    )
    expect(resolvePluginHostRuntime({ pluginId: "p", sessionId: "s2" }).getDefaultProvider()).toBe(
      "ambient"
    )
  })

  it("keeps concurrent sessions on their own runtime", () => {
    registerSessionHostRuntime("a", () => stubRuntime("config-a"))
    registerSessionHostRuntime("b", () => stubRuntime("config-b"))
    expect(resolvePluginHostRuntime({ pluginId: "p", sessionId: "a" }).getDefaultModel()).toBe(
      "config-a-model"
    )
    expect(resolvePluginHostRuntime({ pluginId: "p", sessionId: "b" }).getDefaultModel()).toBe(
      "config-b-model"
    )
  })

  it("releases a binding through the returned disposer", () => {
    const dispose = registerSessionHostRuntime("s1", () => stubRuntime("session-1"))
    expect(hasSessionHostRuntime("s1")).toBe(true)
    dispose()
    expect(hasSessionHostRuntime("s1")).toBe(false)
  })

  it("does not let a stale disposer erase a re-registration of the same id", () => {
    // A session that restarts under the same id re-registers before the old
    // disposer runs. Dropping the NEW binding there would silently unbind a
    // live session and send its calls to the ambient (empty) runtime.
    const disposeFirst = registerSessionHostRuntime("s1", () => stubRuntime("first"))
    registerSessionHostRuntime("s1", () => stubRuntime("second"))
    disposeFirst()
    expect(hasSessionHostRuntime("s1")).toBe(true)
    expect(resolvePluginHostRuntime({ pluginId: "p", sessionId: "s1" }).getDefaultProvider()).toBe(
      "second"
    )
  })

  it("clears a binding unconditionally", () => {
    registerSessionHostRuntime("s1", () => stubRuntime("session-1"))
    clearSessionHostRuntime("s1")
    expect(hasSessionHostRuntime("s1")).toBe(false)
  })

  it("ignores an empty session id", () => {
    const dispose = registerSessionHostRuntime("", () => stubRuntime("nope"))
    expect(hasSessionHostRuntime("")).toBe(false)
    expect(() => dispose()).not.toThrow()
  })
})

describe("session-scoped hosts fail closed", () => {
  it("refuses a call that names no session", () => {
    disableAmbientHostRuntime()
    expect(() => resolvePluginHostRuntime({ pluginId: "p" })).toThrow(
      PluginHostRuntimeUnavailableError
    )
  })

  it("refuses a call naming an unbound session rather than borrowing ambient state", () => {
    // The CLI has no hydrated settings store, and two sessions may hold
    // different provider credentials. Falling back would either read nothing or
    // bill the wrong account — both worse than a clear failure.
    disableAmbientHostRuntime()
    setAmbientHostRuntime(() => stubRuntime("ambient"))
    expect(() => resolvePluginHostRuntime({ pluginId: "p", sessionId: "ghost" })).toThrow(
      /not bound/
    )
  })

  it("still answers a bound session", () => {
    disableAmbientHostRuntime()
    registerSessionHostRuntime("s1", () => stubRuntime("session-1"))
    expect(resolvePluginHostRuntime({ pluginId: "p", sessionId: "s1" }).getDefaultProvider()).toBe(
      "session-1"
    )
  })

  it("carries the failing plugin and session on the error", () => {
    disableAmbientHostRuntime()
    try {
      resolvePluginHostRuntime({ pluginId: "cognia-deep-research", sessionId: "s9" })
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(PluginHostRuntimeUnavailableError)
      const typed = err as PluginHostRuntimeUnavailableError
      expect(typed.pluginId).toBe("cognia-deep-research")
      expect(typed.sessionId).toBe("s9")
    }
  })

  it("restores ambient resolution when re-enabled", () => {
    disableAmbientHostRuntime()
    enableAmbientHostRuntime()
    setAmbientHostRuntime(() => stubRuntime("ambient"))
    expect(resolvePluginHostRuntime({ pluginId: "p" }).getDefaultProvider()).toBe("ambient")
  })
})
