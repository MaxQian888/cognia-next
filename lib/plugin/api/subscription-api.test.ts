/**
 * Tests for the read-only Subscription Plugin API (`ctx.subscription`).
 *
 * Critically asserts the credential-stripping boundary: the active
 * snapshot's `env` (OAuth bearer) and usage `rawHeaders` never leak.
 */

import { createSubscriptionAPI } from "./subscription-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

const listAccounts = jest.fn(async (..._a: unknown[]) => [
  { id: "a1", provider: "anthropic", variant: "anthropic", plan: "max", email: "x@y.z" },
  { id: "a2", provider: "anthropic", variant: "anthropic", plan: "pro" },
])
const getActiveAccount = jest.fn(async (..._a: unknown[]) => ({
  activeAccountId: "a1" as string | undefined,
  env: [["ANTHROPIC_OAUTH_TOKEN", "secret-bearer"]],
}))
jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: (...a: unknown[]) => listAccounts(...a),
  getActiveAccount: (...a: unknown[]) => getActiveAccount(...a),
}))

// --- Dexie subscriptionUsage mock ---------------------------------------
const usageRows = [
  {
    fetchedAt: 200,
    source: "passive",
    status: "allowed",
    localId: 9,
    rawHeaders: { authorization: "Bearer secret" },
  },
  {
    fetchedAt: 100,
    source: "probe",
    status: "allowed",
    localId: 8,
    rawHeaders: { "x-secret": "v" },
  },
]
const creatingHooks = new Set<(pk: unknown, row: unknown) => void>()
const table = {
  orderBy: () => ({
    reverse: () => ({
      limit: (n: number) => ({ toArray: async () => usageRows.slice(0, n) }),
    }),
  }),
  hook: (type: string, fn?: (pk: unknown, row: unknown) => void) => {
    if (type === "creating" && fn) {
      creatingHooks.add(fn)
      return fn
    }
    return { unsubscribe: (f: (pk: unknown, row: unknown) => void) => creatingHooks.delete(f) }
  },
}
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ subscriptionUsage: table }) }))

const PLUGIN = "sub-plugin"

describe("createSubscriptionAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    creatingHooks.clear()
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  it("gates every method behind subscription:read", () => {
    guard.registerPlugin(PLUGIN, [])
    const api = createSubscriptionAPI(PLUGIN)
    expect(() => api.listAccounts("anthropic")).toThrow(PermissionError)
    expect(() => api.getUsage()).toThrow(PermissionError)
  })

  describe("granted", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["subscription:read"]))

    it("lists providers and accounts", async () => {
      const api = createSubscriptionAPI(PLUGIN)
      expect(api.providers()).toEqual(["anthropic", "codex", "opencode"])
      expect(await api.listAccounts("anthropic")).toHaveLength(2)
      expect(listAccounts).toHaveBeenCalledWith("anthropic")
    })

    it("getActiveAccountId returns only the id — never the env bearer", async () => {
      const api = createSubscriptionAPI(PLUGIN)
      const id = await api.getActiveAccountId("anthropic")
      expect(id).toBe("a1")
      // The returned value is a plain string; no env leaks through.
      expect(JSON.stringify(id)).not.toContain("secret-bearer")
    })

    it("getActiveAccountSummary resolves the credential-free summary", async () => {
      const api = createSubscriptionAPI(PLUGIN)
      const summary = await api.getActiveAccountSummary("anthropic")
      expect(summary).toMatchObject({ id: "a1", plan: "max" })
      expect(JSON.stringify(summary)).not.toContain("secret-bearer")
    })

    it("getActiveAccountSummary returns null when nothing is active", async () => {
      getActiveAccount.mockResolvedValueOnce({ activeAccountId: undefined, env: [] } as never)
      const api = createSubscriptionAPI(PLUGIN)
      expect(await api.getActiveAccountSummary("anthropic")).toBeNull()
    })

    it("getUsage strips rawHeaders and localId", async () => {
      const api = createSubscriptionAPI(PLUGIN)
      const rows = await api.getUsage(2)
      expect(rows).toHaveLength(2)
      for (const r of rows) {
        expect(r).not.toHaveProperty("rawHeaders")
        expect(r).not.toHaveProperty("localId")
      }
      expect(JSON.stringify(rows)).not.toContain("Bearer secret")
    })

    it("getLatestUsage returns the newest sanitized row", async () => {
      const api = createSubscriptionAPI(PLUGIN)
      const latest = await api.getLatestUsage()
      expect(latest).toMatchObject({ fetchedAt: 200, source: "passive" })
      expect(latest).not.toHaveProperty("rawHeaders")
    })

    it("onUsageUpdate fires sanitized rows and disposes", () => {
      const api = createSubscriptionAPI(PLUGIN)
      const handler = jest.fn()
      const dispose = api.onUsageUpdate(handler)
      expect(creatingHooks.size).toBe(1)
      // Simulate a Dexie creating hook firing.
      for (const fn of creatingHooks)
        fn("pk", { fetchedAt: 300, rawHeaders: { a: "b" }, localId: 5 })
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ fetchedAt: 300 }))
      expect(handler.mock.calls[0][0]).not.toHaveProperty("rawHeaders")
      dispose()
      expect(creatingHooks.size).toBe(0)
    })
  })
})
