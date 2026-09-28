/**
 * @jest-environment jsdom
 */
import type { CompanionConfig, CompanionConfigStorage } from "@/lib/tauri/companion-storage"

import { createCredentialBook } from "./book"
import {
  MigratingCompanionStorage,
  __resetCredentialBookForTests,
  activeAccountNamespace,
  companionCredentialBook,
  refileCursorNamespace,
} from "./index"
import {
  emptyHostBook,
  type HostBookEnvelope,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import type { CompanionCredentialBook, CompanionHostCredential, CompanionHostKey } from "./types"

jest.mock("@/lib/platform/detect", () => ({ isCapacitor: jest.fn(() => false) }))

const platform = jest.requireMock("@/lib/platform/detect") as { isCapacitor: jest.Mock }

jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(() => null),
}))
jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: jest.fn(() => null),
}))

const runtimeContext = jest.requireMock("@/lib/runtime/runtime-target-context") as {
  getActiveRuntimeTargetContext: jest.Mock
}
const browserVault = jest.requireMock("@/lib/runtime/browser-vault") as {
  getActiveBrowserVault: jest.Mock
}

function memoryRecords(): HostRecordStore {
  let book: HostBookEnvelope = emptyHostBook()
  return {
    async read() {
      return JSON.parse(JSON.stringify(book)) as HostBookEnvelope
    },
    async write(next) {
      book = JSON.parse(JSON.stringify(next)) as HostBookEnvelope
    },
  }
}

function memoryCredentials(): HostCredentialStore {
  const entries = new Map<string, CompanionHostCredential>()
  const id = (key: CompanionHostKey) => `${key.accountNamespace}/${key.hostId}`
  return {
    async load(key) {
      return entries.get(id(key)) ?? null
    },
    async save(key, credential) {
      entries.set(id(key), credential)
    },
    async remove(key) {
      entries.delete(id(key))
    },
  }
}

function legacyStorage(initial: CompanionConfig | null): CompanionConfigStorage & {
  cleared: number
  loads: number
} {
  const state = { current: initial, cleared: 0, loads: 0 }
  return {
    get cleared() {
      return state.cleared
    },
    get loads() {
      return state.loads
    },
    async load() {
      state.loads += 1
      return state.current
    },
    async save(config) {
      state.current = config
    },
    async clear() {
      state.cleared += 1
      state.current = null
    },
  }
}

function config(patch: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    baseUrl: "https://studio.local:27890",
    devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
    deviceKeyThumbprint: "device-thumbprint",
    deviceId: "dev-legacy",
    serverVersion: "0.2.0",
    serverFingerprint: "ff00",
    ...patch,
  }
}

function freshBook(): CompanionCredentialBook {
  return createCredentialBook({ records: memoryRecords(), credentials: memoryCredentials() })
}

beforeEach(() => {
  platform.isCapacitor.mockReturnValue(false)
  runtimeContext.getActiveRuntimeTargetContext.mockReturnValue(null)
  browserVault.getActiveBrowserVault.mockReturnValue(null)
  __resetCredentialBookForTests(null)
})

describe("activeAccountNamespace", () => {
  it("prefers the runtime target context", () => {
    runtimeContext.getActiveRuntimeTargetContext.mockReturnValue({
      accountId: "acct_target",
      targetId: "t1",
    })
    browserVault.getActiveBrowserVault.mockReturnValue({ accountId: "acct_vault" })
    expect(activeAccountNamespace()).toBe("acct_target")
  })

  it("falls back to the unlocked Vault", () => {
    browserVault.getActiveBrowserVault.mockReturnValue({ accountId: "acct_vault" })
    expect(activeAccountNamespace()).toBe("acct_vault")
  })

  it("reports null when nothing is active", () => {
    expect(activeAccountNamespace()).toBeNull()
  })
})

describe("companionCredentialBook", () => {
  it("memoises one book per process", () => {
    expect(companionCredentialBook()).toBe(companionCredentialBook())
  })

  it("can be replaced for tests", () => {
    const injected = freshBook()
    __resetCredentialBookForTests(injected)
    expect(companionCredentialBook()).toBe(injected)
  })
})

describe("refileCursorNamespace", () => {
  it("is a no-op when the namespace has not changed", async () => {
    await expect(refileCursorNamespace("same", "same")).resolves.toBeUndefined()
  })

  it("swallows a missing database rather than failing the migration", async () => {
    await expect(refileCursorNamespace("a", "b")).resolves.toBeUndefined()
  })

  interface CursorRow {
    serverKey: string
    table: string
    since: number
    lastSyncAt: number | null
    lastError: string | null
  }

  /** A `hostSyncCursors` stand-in that actually honours the queried key. */
  function mockCursorTable(rows: CursorRow[]) {
    const state = { put: [] as CursorRow[], deleted: [] as string[] }
    // Without this the registry hands every later case the FIRST case's mock:
    // `doMock` only applies to a module that has not been required yet.
    jest.resetModules()
    jest.doMock("@/lib/db/schema", () => ({
      getDb: () => ({
        hostSyncCursors: {
          where: () => ({
            equals: (key: string) => ({
              toArray: async () => rows.filter((row) => row.serverKey === key),
              delete: async () => {
                state.deleted.push(key)
              },
            }),
          }),
          bulkPut: async (next: CursorRow[]) => state.put.push(...next),
        },
      }),
    }))
    return state
  }

  it("moves every row from the old key onto the new one", async () => {
    const state = mockCursorTable([
      { serverKey: "old", table: "sessions", since: 7, lastSyncAt: 1, lastError: null },
      { serverKey: "old", table: "messages", since: 9, lastSyncAt: 2, lastError: null },
    ])
    const { refileCursorNamespace: scoped } = await import("./index")
    await scoped("old", "acct_a:host-1")
    expect(state.put).toEqual([
      { serverKey: "acct_a:host-1", table: "sessions", since: 7, lastSyncAt: 1, lastError: null },
      { serverKey: "acct_a:host-1", table: "messages", since: 9, lastSyncAt: 2, lastError: null },
    ])
    expect(state.deleted).toContain("old")
    jest.dontMock("@/lib/db/schema")
  })

  it("leaves a watermark already filed under the new key alone", async () => {
    // A sync tick can adopt these keys before the migration reaches them; if
    // the two disagreed on which row survives, whichever ran second would
    // rewind the other's watermark.
    const state = mockCursorTable([
      { serverKey: "old", table: "sessions", since: 7, lastSyncAt: 1, lastError: null },
      { serverKey: "new", table: "sessions", since: 42, lastSyncAt: 9, lastError: null },
      { serverKey: "old", table: "messages", since: 9, lastSyncAt: 2, lastError: null },
    ])
    const { refileCursorNamespace: scoped } = await import("./index")
    await scoped("old", "new")
    expect(state.put).toEqual([
      { serverKey: "new", table: "messages", since: 9, lastSyncAt: 2, lastError: null },
    ])
    // The legacy rows still go, so the next run cannot read them as another
    // host's and wipe the mirror.
    expect(state.deleted).toContain("old")
    jest.dontMock("@/lib/db/schema")
  })

  it("writes nothing when every table is already filed under the new key", async () => {
    const state = mockCursorTable([
      { serverKey: "old", table: "sessions", since: 7, lastSyncAt: 1, lastError: null },
      { serverKey: "new", table: "sessions", since: 42, lastSyncAt: 9, lastError: null },
    ])
    const { refileCursorNamespace: scoped } = await import("./index")
    await scoped("old", "new")
    expect(state.put).toEqual([])
    expect(state.deleted).toContain("old")
    jest.dontMock("@/lib/db/schema")
  })

  it("does not capture an account database after its scope has changed", async () => {
    const state = mockCursorTable([
      { serverKey: "old", table: "sessions", since: 7, lastSyncAt: 1, lastError: null },
    ])
    const { refileCursorNamespace: scoped } = await import("./index")
    await scoped("old", "new", () => false)
    expect(state.put).toEqual([])
    expect(state.deleted).toEqual([])
    jest.dontMock("@/lib/db/schema")
  })

  it("does nothing when the old key holds no cursors", async () => {
    const state = mockCursorTable([
      { serverKey: "somebody-else", table: "sessions", since: 7, lastSyncAt: 1, lastError: null },
    ])
    const { refileCursorNamespace: scoped } = await import("./index")
    await scoped("old", "new")
    expect(state.put).toEqual([])
    expect(state.deleted).toEqual([])
    jest.dontMock("@/lib/db/schema")
  })
})

describe("MigratingCompanionStorage", () => {
  it("hydrates a native legacy pairing through the opening placeholder without treating it as a Host id", async () => {
    platform.isCapacitor.mockReturnValue(true)
    runtimeContext.getActiveRuntimeTargetContext.mockReturnValue({
      accountId: "local_acct_a",
      targetId: "mobile-companion",
    })
    const book = freshBook()
    const storage = new MigratingCompanionStorage({
      book,
      legacy: legacyStorage(config()),
      refileCursors: async () => undefined,
    })
    expect(await storage.load()).toMatchObject({
      accountId: "local_acct_a",
      targetId: "dev-legacy",
      deviceId: "dev-legacy",
    })
  })

  it.each(["save", "clear"] as const)(
    "retains legacy credentials when the account switches during %s cleanup",
    async (operation) => {
      platform.isCapacitor.mockReturnValue(true)
      let namespace = "acct_second"
      let resolveLegacy!: (value: CompanionConfig | null) => void
      const legacy = legacyStorage(config())
      const originalLoad = legacy.load
      legacy.load = jest.fn(
        () =>
          new Promise((resolve) => {
            resolveLegacy = resolve
          })
      )
      const storage = new MigratingCompanionStorage({
        book: freshBook(),
        legacy,
        accountNamespace: () => namespace,
        refileCursors: async () => undefined,
      })
      const pending =
        operation === "save" ? storage.save(config({ deviceId: "new-device" })) : storage.clear()
      while (!resolveLegacy) await Promise.resolve()
      namespace = "local_acct_a"
      resolveLegacy(config())
      await pending
      expect(legacy.cleared).toBe(0)
      legacy.load = originalLoad
      expect(await storage.load()).toMatchObject({
        accountId: "local_acct_a",
        deviceId: "dev-legacy",
      })
    }
  )

  it.each(["save", "clear", "remove"] as const)(
    "rejects %s if the owner changes while migration is pending",
    async (operation) => {
      platform.isCapacitor.mockReturnValue(true)
      let namespace = "acct_second"
      let resolveLegacy!: (value: CompanionConfig | null) => void
      const legacy = legacyStorage(null)
      legacy.load = () =>
        new Promise((resolve) => {
          resolveLegacy = resolve
        })
      const book = freshBook()
      const write = jest.spyOn(book, "upsert")
      const remove = jest.spyOn(book, "remove")
      const storage = new MigratingCompanionStorage({
        book,
        legacy,
        accountNamespace: () => namespace,
      })
      const migration = storage.load()
      const mutation = operation === "clear" ? storage.clear() : storage[operation](config())
      const rejected = expect(mutation).rejects.toThrow("Companion account changed")
      namespace = "local_acct_a"
      resolveLegacy(null)
      await Promise.all([migration, rejected])
      expect(write).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(legacy.cleared).toBe(0)
    }
  )

  it("defers migration if the profile changes during the legacy read", async () => {
    platform.isCapacitor.mockReturnValue(true)
    let namespace = "local_acct_a"
    let resolveLegacy!: (value: CompanionConfig | null) => void
    const legacy = legacyStorage(config())
    legacy.load = () =>
      new Promise((resolve) => {
        resolveLegacy = resolve
      })
    const book = freshBook()
    const refile = jest.fn()
    const storage = new MigratingCompanionStorage({
      book,
      legacy,
      accountNamespace: () => namespace,
      refileCursors: refile,
    })
    const pending = storage.load()
    namespace = "acct_second"
    resolveLegacy(config())
    expect(await pending).toBeNull()
    expect(await book.list("local_acct_a")).toEqual([])
    expect(await book.list("acct_second")).toEqual([])
    expect(refile).not.toHaveBeenCalled()
    expect(legacy.cleared).toBe(0)
  })

  it("defers unscoped native credentials until their historical account is active", async () => {
    platform.isCapacitor.mockReturnValue(true)
    let namespace = "acct_second"
    const legacy = legacyStorage(config())
    const book = freshBook()
    const storage = new MigratingCompanionStorage({
      book,
      legacy,
      accountNamespace: () => namespace,
      refileCursors: async () => undefined,
    })
    expect(await storage.load()).toBeNull()
    expect(await book.list("acct_second")).toEqual([])
    expect(legacy.cleared).toBe(0)
    namespace = "local_acct_a"
    expect(await storage.load()).toMatchObject({
      accountId: "local_acct_a",
      deviceId: "dev-legacy",
    })
    expect(legacy.cleared).toBe(1)
  })

  it.each(["save", "clear"] as const)(
    "does not erase another native profile's legacy pairing on %s",
    async (operation) => {
      platform.isCapacitor.mockReturnValue(true)
      let namespace = "acct_second"
      const legacy = legacyStorage(config())
      const book = freshBook()
      const storage = new MigratingCompanionStorage({
        book,
        legacy,
        accountNamespace: () => namespace,
        refileCursors: async () => undefined,
      })
      if (operation === "save")
        await storage.save(config({ accountId: namespace, deviceId: "new-device" }))
      else await storage.clear()
      expect(legacy.cleared).toBe(0)
      namespace = "local_acct_a"
      expect(await storage.load()).toMatchObject({
        accountId: "local_acct_a",
        deviceId: "dev-legacy",
      })
    }
  )

  it("migrates the legacy record on first load and clears the source", async () => {
    const legacy = legacyStorage(config({ accountId: "acct_a" }))
    const book = freshBook()
    const storage = new MigratingCompanionStorage({
      book,
      legacy,
      accountNamespace: () => "acct_a",
      refileCursors: async () => undefined,
    })
    const loaded = await storage.load()
    expect(loaded).toMatchObject({
      devicePrivateKeyJwk: { d: "device-private" },
      deviceId: "dev-legacy",
    })
    expect(legacy.cleared).toBe(1)
    expect(await book.list("acct_a")).toHaveLength(1)
  })

  it("runs the migration exactly once even under concurrent loads", async () => {
    const legacy = legacyStorage(config({ accountId: "acct_a" }))
    const storage = new MigratingCompanionStorage({
      book: freshBook(),
      legacy,
      accountNamespace: () => "acct_a",
      refileCursors: async () => undefined,
    })
    await Promise.all([storage.load(), storage.load(), storage.load()])
    expect(legacy.cleared).toBe(1)
    // Three concurrent loads, one migration read.
    expect(legacy.loads).toBe(1)
  })

  it("reports the migration outcome to the caller", async () => {
    const outcomes: string[] = []
    const storage = new MigratingCompanionStorage({
      book: freshBook(),
      legacy: legacyStorage(config({ accountId: "acct_a" })),
      accountNamespace: () => "acct_a",
      refileCursors: async () => undefined,
      onMigrated: (outcome) => outcomes.push(outcome.kind),
    })
    await storage.load()
    expect(outcomes).toEqual(["migrated"])
  })

  it("does not run the migration before a save, so a fresh pairing wins", async () => {
    const legacy = legacyStorage(config({ accountId: "acct_a", deviceId: "old-device" }))
    const book = freshBook()
    const storage = new MigratingCompanionStorage({
      book,
      legacy,
      accountNamespace: () => "acct_a",
      refileCursors: async () => undefined,
    })
    await storage.save(config({ accountId: "acct_a", deviceId: "new-device" }))
    expect(legacy.loads).toBe(0)
    expect((await book.getActive("acct_a"))?.deviceId).toBe("new-device")
    expect((await storage.load())?.deviceId).toBe("new-device")
    // The legacy record is dropped by the save, so the later load has nothing
    // to migrate and cannot resurrect the old pairing.
    expect(await book.list("acct_a")).toHaveLength(1)
  })

  it("clears both the book and the legacy record", async () => {
    const legacy = legacyStorage(config({ accountId: "acct_a" }))
    const book = freshBook()
    const storage = new MigratingCompanionStorage({
      book,
      legacy,
      accountNamespace: () => "acct_a",
      refileCursors: async () => undefined,
    })
    await storage.save(config({ accountId: "acct_a" }))
    await storage.clear()
    expect(await book.list("acct_a")).toEqual([])
    expect(legacy.cleared).toBeGreaterThan(0)
  })

  it("re-attempts on the next load when the migration throws", async () => {
    let attempts = 0
    const legacy: CompanionConfigStorage = {
      async load() {
        attempts += 1
        if (attempts === 1) throw new Error("keystore busy")
        return config({ accountId: "acct_a" })
      },
      async save() {},
      async clear() {},
    }
    const storage = new MigratingCompanionStorage({
      book: freshBook(),
      legacy,
      accountNamespace: () => "acct_a",
      refileCursors: async () => undefined,
    })
    expect(await storage.load()).toBeNull()
    expect(await storage.load()).toMatchObject({
      devicePrivateKeyJwk: { d: "device-private" },
    })
    expect(attempts).toBe(2)
  })

  it("uses the shared book when none is injected", async () => {
    const injected = freshBook()
    __resetCredentialBookForTests(injected)
    const storage = new MigratingCompanionStorage({ legacy: legacyStorage(null) })
    await storage.save(config({ accountId: "acct_a" }))
    expect(await injected.list("acct_a")).toHaveLength(1)
  })

  it("falls back to the reserved namespace when nothing at all is active", async () => {
    const book = freshBook()
    __resetCredentialBookForTests(book)
    const storage = new MigratingCompanionStorage({
      legacy: legacyStorage(config()),
      accountNamespace: () => null,
      refileCursors: async () => undefined,
    })
    await storage.load()
    expect(await book.list("__local__")).toHaveLength(1)
  })

  it("resolves the namespace from the ambient runtime context by default", async () => {
    runtimeContext.getActiveRuntimeTargetContext.mockReturnValue({
      accountId: "acct_ambient",
      targetId: "t1",
    })
    const book = freshBook()
    __resetCredentialBookForTests(book)
    const storage = new MigratingCompanionStorage({ legacy: legacyStorage(null) })
    await storage.save(config())
    expect(await book.list("acct_ambient")).toHaveLength(1)
  })
})

it("delegates metadata updates without replaying a pairing save", async () => {
  const book = freshBook()
  const legacy = legacyStorage(null)
  const storage = new MigratingCompanionStorage({ book, legacy, accountNamespace: () => "acct_a" })
  await storage.save(config({ targetId: "host-1" }))
  const saved = (await storage.load())!
  const secretSave = jest.spyOn(book, "saveCredential")
  expect(
    await storage.updateMetadata({ ...saved, tunnelBaseUrl: "https://new.example" }, () => true)
  ).toBe(true)
  expect((await storage.load())?.tunnelBaseUrl).toBe("https://new.example")
  expect(secretSave).not.toHaveBeenCalled()
})
