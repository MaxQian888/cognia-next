import { createAuthAPI, type PluginAuthProvider } from "./auth-api"
import {
  __resetAuthRegistryForTesting,
  __makeSession,
  listProviders,
  type AuthSession,
} from "@/lib/plugin/auth/auth-provider-registry"

function fakeProvider(over?: Partial<PluginAuthProvider>): PluginAuthProvider {
  const session: AuthSession = __makeSession({
    accessToken: "tok",
    account: { id: "u1", label: "User" },
    scopes: ["repo"],
  })
  return {
    id: "acme",
    label: "Acme",
    getSessions: async () => [session],
    createSession: async () => session,
    removeSession: async () => {},
    ...over,
  }
}

const allow = { hasPermission: () => true }
const deny = { hasPermission: () => false }

describe("createAuthAPI", () => {
  afterEach(() => __resetAuthRegistryForTesting())

  describe("permission gating", () => {
    it("registerProvider requires auth:provide", () => {
      const api = createAuthAPI("p", deny)
      expect(() => api.registerProvider(fakeProvider())).toThrow(/auth:provide/)
    })

    it("getSession/getSessions require auth:consume", async () => {
      const api = createAuthAPI("p", { hasPermission: (perm) => perm === "auth:provide" })
      api.registerProvider(fakeProvider())
      await expect(api.getSession("acme", ["repo"])).rejects.toThrow(/auth:consume/)
      await expect(api.getSessions("acme")).rejects.toThrow(/auth:consume/)
    })

    it("createPkceFlow requires auth:provide", async () => {
      const api = createAuthAPI("p", deny)
      await expect(
        api.createPkceFlow({
          authorizeUrl: "https://a",
          tokenUrl: "https://t",
          clientId: "c",
          scopes: [],
          redirectUri: "http://localhost",
          openUrl: () => {},
          waitForCode: async () => ({ code: "x", state: "y" }),
        })
      ).rejects.toThrow(/auth:provide/)
    })
  })

  it("registers a provider stamped with the plugin id", () => {
    const api = createAuthAPI("plugin-a", allow)
    api.registerProvider(fakeProvider())
    const [p] = listProviders()
    expect(p).toMatchObject({ id: "acme", pluginId: "plugin-a" })
  })

  it("getSessions delegates to the provider (silent)", async () => {
    const api = createAuthAPI("p", allow)
    const getSessions = jest.fn(async () => [
      __makeSession({ accessToken: "t", account: { id: "u", label: "U" }, scopes: [] }),
    ])
    api.registerProvider(fakeProvider({ getSessions }))
    const sessions = await api.getSessions("acme", ["repo"])
    expect(sessions).toHaveLength(1)
    expect(getSessions).toHaveBeenCalledWith(["repo"], { silent: true })
  })

  it("getSessions throws for an unknown provider", async () => {
    const api = createAuthAPI("p", allow)
    await expect(api.getSessions("nope")).rejects.toThrow(/No auth provider/)
  })

  it("getSession returns an existing matching session", async () => {
    const api = createAuthAPI("p", allow)
    api.registerProvider(fakeProvider())
    const session = await api.getSession("acme", ["repo"])
    expect(session?.accessToken).toBe("tok")
  })

  it("onDidChangeSessions observes session changes", async () => {
    const api = createAuthAPI("p", allow)
    const events: unknown[] = []
    api.onDidChangeSessions((e) => events.push(e))
    api.registerProvider(
      fakeProvider({
        getSessions: async () => [],
        createSession: async () =>
          __makeSession({ accessToken: "new", account: { id: "u", label: "U" }, scopes: ["repo"] }),
      })
    )
    await api.getSession("acme", ["repo"], { createIfNone: true })
    await new Promise((r) => queueMicrotask(() => r(null)))
    expect(events.length).toBeGreaterThan(0)
  })
})
