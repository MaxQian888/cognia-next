import {
  __makeSession,
  __resetAuthRegistryForTesting,
  getProvider,
  getSession,
  hydrateFromSecrets,
  listProviders,
  onDidChangeSessions,
  registerAuthenticationProvider,
  removeSession,
  setSecretsAdapter,
  unregisterAuthenticationProvider,
  unregisterProvidersByPlugin,
  type AuthSession,
  type AuthSessionOptions,
  type AuthenticationProvider,
  type SecretsAdapter,
} from "./auth-provider-registry"

function makeMemorySecretsAdapter(): SecretsAdapter {
  const store = new Map<string, string>()
  return {
    async get(key) {
      return store.get(key)
    },
    async set(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

function makeProvider(overrides: Partial<AuthenticationProvider> = {}): AuthenticationProvider {
  const sessions: AuthSession[] = []
  const provider: AuthenticationProvider = {
    id: "github",
    label: "GitHub",
    pluginId: "vscode.github-authentication",
    getSessions: jest.fn(
      async (scopes: readonly string[] | undefined, _options: AuthSessionOptions) => {
        if (!scopes) return sessions
        return sessions.filter((s) => scopes.every((scope) => s.scopes.includes(scope)))
      }
    ),
    createSession: jest.fn(async (scopes: readonly string[]) => {
      const session = __makeSession({
        accessToken: "gho_test_token",
        account: { id: "1", label: "octocat" },
        scopes,
      })
      sessions.push(session)
      return session
    }),
    removeSession: jest.fn(async (sessionId: string) => {
      const idx = sessions.findIndex((s) => s.id === sessionId)
      if (idx >= 0) sessions.splice(idx, 1)
    }),
    ...overrides,
  }
  return provider
}

describe("auth provider registry", () => {
  beforeEach(() => {
    __resetAuthRegistryForTesting()
  })

  describe("provider registration", () => {
    it("registers and lists a provider", () => {
      const dispose = registerAuthenticationProvider(makeProvider())
      expect(listProviders().map((p) => p.id)).toEqual(["github"])
      expect(getProvider("github")?.label).toBe("GitHub")
      dispose()
      expect(getProvider("github")).toBeUndefined()
    })

    it("warns on duplicate id and overrides", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerAuthenticationProvider(makeProvider({ id: "x", label: "A", pluginId: "p1" }))
        registerAuthenticationProvider(makeProvider({ id: "x", label: "B", pluginId: "p2" }))
        expect(getProvider("x")?.label).toBe("B")
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/replaced/))
      } finally {
        warn.mockRestore()
      }
    })

    it("bulk-unregisters providers by plugin id", () => {
      registerAuthenticationProvider(makeProvider({ id: "a", pluginId: "p1" }))
      registerAuthenticationProvider(makeProvider({ id: "b", pluginId: "p1" }))
      registerAuthenticationProvider(makeProvider({ id: "c", pluginId: "p2" }))
      const removed = unregisterProvidersByPlugin("p1")
      expect(removed).toBe(2)
      expect(listProviders().map((p) => p.id)).toEqual(["c"])
    })

    it("idempotent unregister", () => {
      registerAuthenticationProvider(makeProvider({ id: "x" }))
      unregisterAuthenticationProvider("x")
      expect(() => unregisterAuthenticationProvider("x")).not.toThrow()
    })
  })

  describe("getSession", () => {
    it("throws when the provider is unknown", async () => {
      await expect(getSession("nope", ["scope"])).rejects.toThrow(/No auth provider/)
    })

    it("returns undefined when neither createIfNone nor an existing session matches", async () => {
      registerAuthenticationProvider(makeProvider())
      const session = await getSession("github", ["repo"])
      expect(session).toBeUndefined()
    })

    it("returns an existing session when one matches the scopes", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      // Seed an existing session by triggering createIfNone first.
      await getSession("github", ["repo"], { createIfNone: true })
      const existing = await getSession("github", ["repo"])
      expect(existing).toBeDefined()
      expect(existing?.scopes).toContain("repo")
    })

    it("creates a new session when createIfNone is true and none exists", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      const session = await getSession("github", ["read:user"], { createIfNone: true })
      expect(session).toBeDefined()
      expect(provider.createSession).toHaveBeenCalledTimes(1)
    })

    it("creates a fresh session when forceNewSession is true even if one exists", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      await getSession("github", ["x"], { createIfNone: true })
      const session2 = await getSession("github", ["x"], { forceNewSession: true })
      expect(session2).toBeDefined()
      expect(provider.createSession).toHaveBeenCalledTimes(2)
    })
  })

  describe("removeSession", () => {
    it("calls provider.removeSession and emits a removed event", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      const adapter = makeMemorySecretsAdapter()
      setSecretsAdapter(adapter)
      const session = await getSession("github", ["x"], { createIfNone: true })

      const events: AuthSession[][] = []
      onDidChangeSessions((e) => events.push(e.removed))
      await removeSession("github", session!.id)
      await new Promise((r) => setTimeout(r, 0))
      expect(provider.removeSession).toHaveBeenCalledWith(session!.id)
      expect(events.flat().map((s) => s.id)).toContain(session!.id)
    })

    it("is a silent no-op for an unknown provider", async () => {
      await expect(removeSession("nope", "sid")).resolves.toBeUndefined()
    })
  })

  describe("persistence", () => {
    it("persists newly-created sessions to the secrets adapter", async () => {
      const adapter = makeMemorySecretsAdapter()
      setSecretsAdapter(adapter)
      registerAuthenticationProvider(makeProvider())
      const session = await getSession("github", ["x"], { createIfNone: true })
      expect(session).toBeDefined()
      const keys = await adapter.list("auth:github:")
      expect(keys).toHaveLength(1)
      const raw = await adapter.get(keys[0]!)
      expect(JSON.parse(raw!)).toMatchObject({ accessToken: "gho_test_token" })
    })

    it("hydrateFromSecrets re-reads persisted sessions", async () => {
      const adapter = makeMemorySecretsAdapter()
      const fakeSession: AuthSession = {
        id: "abc",
        accessToken: "tok",
        account: { id: "1", label: "u" },
        scopes: ["x"],
      }
      await adapter.set(`auth:github:${fakeSession.id}`, JSON.stringify(fakeSession))
      setSecretsAdapter(adapter)
      const count = await hydrateFromSecrets()
      expect(count).toBe(1)
    })

    it("hydrateFromSecrets returns 0 with no adapter installed", async () => {
      setSecretsAdapter(null)
      const count = await hydrateFromSecrets()
      expect(count).toBe(0)
    })

    it("hydrateFromSecrets tolerates malformed entries", async () => {
      const adapter = makeMemorySecretsAdapter()
      await adapter.set("auth:bad", "not-json")
      setSecretsAdapter(adapter)
      const count = await hydrateFromSecrets()
      expect(count).toBe(0)
    })
  })

  describe("listeners", () => {
    it("survives a listener that throws", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerAuthenticationProvider(makeProvider())
        onDidChangeSessions(() => {
          throw new Error("listener boom")
        })
        await getSession("github", ["x"], { createIfNone: true })
        await new Promise((r) => setTimeout(r, 0))
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})
