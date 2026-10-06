/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"

const startHeadlessAccountSync = jest.fn()
const ownAccountDatabase = jest.fn()

jest.mock("@/lib/account-sync/data/headless-host", () => ({
  startHeadlessAccountSync: (deps: unknown) => startHeadlessAccountSync(deps),
}))
jest.mock("@/lib/account-sync/data/own-database", () => ({
  ownAccountDatabase: (id: string) => ownAccountDatabase(id),
}))

function context(accountSync?: HeadlessRuntimeContext["accountSync"]): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "local_acct_a",
    bridge: {
      listen: async () => () => undefined,
      invoke: jest.fn(),
      respondMedia: async () => {},
    },
    notifyDbWrite: jest.fn(),
    resolveMessage: (key) => key,
    log: jest.fn(),
    ...(accountSync ? { accountSync } : {}),
  }
}

async function runtime() {
  jest.resetModules()
  const registry = await import("../registry")
  registry.__resetHeadlessRuntimesForTesting()
  await import("./account-sync")
  return registry.listHeadlessRuntimes().find((entry) => entry.name === "account-sync")!
}

beforeEach(() => {
  startHeadlessAccountSync.mockReset()
  ownAccountDatabase.mockReset()
})

it("does nothing when the serve process left account sync off", async () => {
  const entry = await runtime()
  expect(entry.hosts).toEqual(["brain"])
  expect(await entry.start(context())).toBeUndefined()
  expect(startHeadlessAccountSync).not.toHaveBeenCalled()
})

it("syncs the brain's own database and stops with the brain", async () => {
  const stop = jest.fn()
  startHeadlessAccountSync.mockReturnValue({ stop, check: jest.fn() })
  const host = { session: async () => null, keyring: {} as never, backup: async () => undefined }
  const ctx = context(host)
  const entry = await runtime()
  const teardown = await entry.start(ctx)
  const deps = startHeadlessAccountSync.mock.calls[0]![0] as {
    host: unknown
    db: () => unknown
    log: (level: "info" | "error", message: string) => void
  }
  expect(deps.host).toBe(host)
  ownAccountDatabase.mockReturnValue("db")
  expect(deps.db()).toBe("db")
  expect(ownAccountDatabase).toHaveBeenCalledWith("local_acct_a")
  deps.log("info", "account sync: syncing")
  expect(ctx.log).toHaveBeenCalledWith("info", "account sync: syncing")
  ;(teardown as () => void)()
  expect(stop).toHaveBeenCalled()
})
