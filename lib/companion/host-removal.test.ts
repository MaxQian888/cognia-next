import type { CompanionCredentialBook, CompanionHostRecord } from "./credential-book"
import { removeCompanionHost, type HostRemovalDependencies } from "./host-removal"

const accountId = "local_acct_a"
const host = (hostId: string): CompanionHostRecord => ({
  hostId,
  accountNamespace: accountId,
  label: hostId,
  endpoints: { baseUrl: `https://${hostId}.local:7890` },
  tlsPin: `pin-${hostId}`,
  cursorNamespace: `${accountId}:${hostId}`,
  deviceId: `device-${hostId}`,
  deviceKeyThumbprint: `thumb-${hostId}`,
  serverVersion: "1.0.0",
  connection: { status: "online", generation: 0, lastOkAt: 1, lastErrorAt: null, lastError: null },
  createdAt: 1,
  updatedAt: 1,
})

function harness(options: { hosts?: string[]; active?: string; revokeFails?: boolean } = {}) {
  const hosts = (options.hosts ?? ["host-a", "host-b"]).map(host)
  let activeId = options.active ?? "host-a"
  const removed: string[] = []
  const switched: string[] = []
  const book = {
    list: async () => hosts.filter((item) => !removed.includes(item.hostId)),
    get: async ({ hostId }: { hostId: string }) =>
      hosts.find((item) => item.hostId === hostId) ?? null,
    getActive: async () => hosts.find((item) => item.hostId === activeId) ?? null,
    setActive: async ({ hostId }: { hostId: string }) => {
      activeId = hostId
    },
    clearActive: jest.fn(async () => {
      activeId = ""
    }),
    loadCredential: async () => ({ devicePrivateKeyJwk: { kty: "EC", d: "secret" } }),
    remove: async ({ hostId }: { hostId: string }) => {
      removed.push(hostId)
    },
  } as unknown as CompanionCredentialBook
  const dependencies: HostRemovalDependencies = {
    book,
    switchHost: async ({ hostId }) => {
      switched.push(hostId)
      activeId = hostId
    },
    switchWebStandalone: async () => {
      switched.push("web-standalone")
    },
    quiesceSoleMobile: jest.fn().mockResolvedValue(undefined),
    revoke: options.revokeFails
      ? jest.fn().mockRejectedValue(new Error("offline"))
      : jest.fn().mockResolvedValue({ kind: "revoked" }),
    deleteRuntimeTarget: jest.fn().mockResolvedValue(undefined),
    deleteActiveRuntimeTarget: jest.fn().mockResolvedValue(undefined),
    deleteDatabase: jest.fn().mockResolvedValue(undefined),
    databaseExists: jest.fn().mockResolvedValue(false),
    removeRecentAlias: jest.fn(),
    enterUnpaired: jest.fn().mockResolvedValue(undefined),
  }
  return { dependencies, removed, switched, active: () => activeId }
}

it("requires an explicit fallback for active removal when alternatives exist", async () => {
  const { dependencies } = harness()
  await expect(
    removeCompanionHost({ accountId, hostId: "host-a", platform: "mobile" }, dependencies)
  ).rejects.toThrow(/fallback Host is required/i)
  expect(dependencies.revoke).not.toHaveBeenCalled()
})

it("switches to the selected fallback before explicit revocation and cleanup", async () => {
  const { dependencies, removed, switched, active } = harness()
  await removeCompanionHost(
    { accountId, hostId: "host-a", fallbackHostId: "host-b", platform: "mobile" },
    dependencies
  )

  expect(switched).toEqual(["host-b"])
  expect(active()).toBe("host-b")
  expect(dependencies.revoke).toHaveBeenCalledWith(expect.objectContaining({ targetId: "host-a" }))
  expect(removed).toEqual(["host-a"])
  expect(dependencies.deleteDatabase).toHaveBeenCalled()
  expect(dependencies.removeRecentAlias).toHaveBeenCalledWith("https://host-a.local:7890")
})

it("keeps every local record when remote revocation fails after fallback switching", async () => {
  const { dependencies, removed, active } = harness({ revokeFails: true })
  await expect(
    removeCompanionHost(
      { accountId, hostId: "host-a", fallbackHostId: "host-b", platform: "mobile" },
      dependencies
    )
  ).rejects.toThrow("offline")

  expect(active()).toBe("host-b")
  expect(removed).toEqual([])
  expect(dependencies.deleteRuntimeTarget).not.toHaveBeenCalled()
  expect(dependencies.deleteDatabase).not.toHaveBeenCalled()
})

it("revokes the sole Mobile Host while active, then enters unpaired flow", async () => {
  const { dependencies } = harness({ hosts: ["host-a"] })
  await removeCompanionHost({ accountId, hostId: "host-a", platform: "mobile" }, dependencies)

  expect(dependencies.quiesceSoleMobile).toHaveBeenCalled()
  expect(dependencies.deleteActiveRuntimeTarget).toHaveBeenCalledWith(accountId, "host-a")
  expect(dependencies.enterUnpaired).toHaveBeenCalled()
})

it("switches Web to standalone before revoking its sole Companion Host", async () => {
  const { dependencies, switched } = harness({ hosts: ["host-a"] })
  await removeCompanionHost({ accountId, hostId: "host-a", platform: "web" }, dependencies)
  expect(switched).toEqual(["web-standalone"])
  expect(dependencies.deleteRuntimeTarget).toHaveBeenCalledWith(accountId, "host-a")
})
