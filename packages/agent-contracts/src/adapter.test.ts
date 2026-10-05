import {
  EXTERNAL_AGENT_ADAPTER_CORE_METHODS,
  missingAdapterCoreMethods,
  supportsAuthentication,
  supportsCompaction,
  supportsModelCatalog,
  supportsSessionFork,
  supportsSessionListing,
  supportsSessionModels,
  supportsSessionRegistry,
  supportsSessionResume,
  supportsTurnSteering,
  type ExternalAgentAdapterCore,
} from "./adapter"

function core(extra: Record<string, unknown> = {}): ExternalAgentAdapterCore {
  const methods = Object.fromEntries(
    EXTERNAL_AGENT_ADAPTER_CORE_METHODS.map((name) => [name, () => undefined])
  )
  return {
    protocol: "test",
    connectionStatus: "connected",
    ...methods,
    ...extra,
  } as unknown as ExternalAgentAdapterCore
}

describe("adapter core", () => {
  it("names exactly the members every adapter must implement", () => {
    expect([...EXTERNAL_AGENT_ADAPTER_CORE_METHODS]).toEqual([
      "connect",
      "disconnect",
      "isConnected",
      "createSession",
      "closeSession",
      "prompt",
      "execute",
      "respondToPermission",
      "cancel",
      "getSession",
      "getSessions",
      "healthCheck",
    ])
  })

  it("reports the core methods a plugin object lacks", () => {
    expect(missingAdapterCoreMethods(core())).toEqual([])
    const partial = { connect: () => {}, prompt: () => {}, healthCheck: "not a function" }
    expect(missingAdapterCoreMethods(partial)).toEqual([
      "disconnect",
      "isConnected",
      "createSession",
      "closeSession",
      "execute",
      "respondToPermission",
      "cancel",
      "getSession",
      "getSessions",
      "healthCheck",
    ])
  })
})

describe("capability guards", () => {
  it("are false for a core-only adapter", () => {
    const adapter = core()
    expect(supportsSessionRegistry(adapter)).toBe(false)
    expect(supportsSessionResume(adapter)).toBe(false)
    expect(supportsSessionFork(adapter)).toBe(false)
    expect(supportsTurnSteering(adapter)).toBe(false)
    expect(supportsSessionModels(adapter)).toBe(false)
    expect(supportsAuthentication(adapter)).toBe(false)
    expect(supportsCompaction(adapter)).toBe(false)
    expect(supportsSessionListing(adapter)).toBe(false)
    expect(supportsModelCatalog(adapter)).toBe(false)
    expect(supportsModelCatalog(core({ listCatalogModels: () => Promise.resolve([]) }))).toBe(true)
  })

  it("require every member of a multi-method capability", () => {
    const fn = () => undefined
    expect(supportsSessionModels(core({ setSessionModel: fn }))).toBe(false)
    expect(supportsSessionModels(core({ setSessionModel: fn, getSessionModels: fn }))).toBe(true)
    expect(supportsAuthentication(core({ getAuthMethods: fn, authenticate: fn }))).toBe(false)
    expect(
      supportsAuthentication(
        core({ getAuthMethods: fn, isAuthenticationRequired: fn, authenticate: fn })
      )
    ).toBe(true)
    expect(supportsCompaction(core({ compactSession: fn }))).toBe(false)
  })

  it("detect single-method capabilities, including class prototypes", () => {
    class Resumable {
      resumeSession() {}
      forkSession() {}
      steerTurn() {}
      forgetSessions() {}
      listSessions() {}
    }
    const adapter = Object.assign(new Resumable(), core()) as unknown as ExternalAgentAdapterCore
    expect(supportsSessionResume(adapter)).toBe(true)
    expect(supportsSessionFork(adapter)).toBe(true)
    expect(supportsTurnSteering(adapter)).toBe(true)
    expect(supportsSessionRegistry(adapter)).toBe(true)
    expect(supportsSessionListing(adapter)).toBe(true)
  })
})
