import { createCredentialBook } from "./book"
import {
  emptyHostBook,
  type HostBookEnvelope,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import {
  StaleConnectionGenerationError,
  type CompanionHostCredential,
  type CompanionHostDraft,
  type CompanionHostKey,
} from "./types"

function memoryRecords(): HostRecordStore & { book: HostBookEnvelope; writes: number } {
  const state = { book: emptyHostBook(), writes: 0 }
  return {
    get book() {
      return state.book
    },
    get writes() {
      return state.writes
    },
    async read() {
      return JSON.parse(JSON.stringify(state.book)) as HostBookEnvelope
    },
    async write(next) {
      state.writes += 1
      state.book = JSON.parse(JSON.stringify(next)) as HostBookEnvelope
    },
  }
}

function memoryCredentials(): HostCredentialStore & {
  entries: Map<string, CompanionHostCredential>
} {
  const entries = new Map<string, CompanionHostCredential>()
  const id = (key: CompanionHostKey) => `${key.accountNamespace}/${key.hostId}`
  return {
    entries,
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

function draft(patch: Partial<CompanionHostDraft> = {}): CompanionHostDraft {
  return {
    hostId: "host-1",
    accountNamespace: "acct_a",
    label: "Studio",
    endpoints: { baseUrl: "https://10.0.0.1:27890" },
    tlsPin: "aa11",
    deviceId: "dev-1",
    deviceKeyThumbprint: "device-thumbprint",
    serverVersion: "0.2.0",
    ...patch,
  }
}

function harness(now = () => 1_000) {
  const records = memoryRecords()
  const credentials = memoryCredentials()
  return { records, credentials, book: createCredentialBook({ records, credentials, now }) }
}

describe("upsert", () => {
  it("assigns a namespace and stamps both timestamps on creation", async () => {
    const { book } = harness()
    const record = await book.upsert(draft())
    expect(record.cursorNamespace).toBe("acct_a:host-1")
    expect(record.createdAt).toBe(1_000)
    expect(record.updatedAt).toBe(1_000)
    expect(record.connection.generation).toBe(0)
  })

  it("never moves an assigned namespace, even when the host id would derive a new one", async () => {
    const records = memoryRecords()
    const credentials = memoryCredentials()
    const book = createCredentialBook({ records, credentials, now: () => 1 })
    await book.upsert(draft())
    // Simulate a record whose namespace was assigned under an older scheme.
    const stored = await records.read()
    stored.hosts["acct_a:host-1"].cursorNamespace = "legacy-namespace"
    await records.write(stored)

    const updated = await book.upsert(draft({ label: "Renamed" }))
    expect(updated.cursorNamespace).toBe("legacy-namespace")
    expect(updated.label).toBe("Renamed")
  })

  it("preserves createdAt and the connection state across updates", async () => {
    let clock = 10
    const { book } = harness(() => clock)
    await book.upsert(draft())
    await book.updateConnection(
      { hostId: "host-1", accountNamespace: "acct_a" },
      { status: "online" }
    )
    clock = 50
    const updated = await book.upsert(draft({ label: "Renamed" }))
    expect(updated.createdAt).toBe(10)
    expect(updated.updatedAt).toBe(50)
    expect(updated.connection.status).toBe("online")
    expect(updated.connection.generation).toBe(1)
  })

  it("makes the first pairing for an account active", async () => {
    const { book } = harness()
    await book.upsert(draft())
    expect((await book.getActive("acct_a"))?.hostId).toBe("host-1")
  })

  it("does not steal the active pointer from an existing host", async () => {
    const { book } = harness()
    await book.upsert(draft())
    await book.upsert(draft({ hostId: "host-2", label: "Laptop" }))
    expect((await book.getActive("acct_a"))?.hostId).toBe("host-1")
  })

  it("serialises concurrent upserts so neither write is lost", async () => {
    const { book } = harness()
    await Promise.all([
      book.upsert(draft({ hostId: "a", label: "A" })),
      book.upsert(draft({ hostId: "b", label: "B" })),
      book.upsert(draft({ hostId: "c", label: "C" })),
    ])
    expect((await book.list("acct_a")).map((r) => r.hostId)).toEqual(["a", "b", "c"])
  })
})

describe("list / get", () => {
  it("scopes to one account namespace", async () => {
    const { book } = harness()
    await book.upsert(draft())
    await book.upsert(draft({ accountNamespace: "acct_b", label: "Other" }))
    expect((await book.list("acct_a")).map((r) => r.accountNamespace)).toEqual(["acct_a"])
    expect(await book.list()).toHaveLength(2)
  })

  it("sorts by label, then host id", async () => {
    const { book } = harness()
    await book.upsert(draft({ hostId: "z", label: "Alpha" }))
    await book.upsert(draft({ hostId: "a", label: "Alpha" }))
    await book.upsert(draft({ hostId: "m", label: "Beta" }))
    expect((await book.list("acct_a")).map((r) => r.hostId)).toEqual(["a", "z", "m"])
  })

  it("returns null for an unknown key", async () => {
    const { book } = harness()
    expect(await book.get({ hostId: "nope", accountNamespace: "acct_a" })).toBeNull()
  })

  it("does not confuse the same host id under two accounts", async () => {
    const { book } = harness()
    await book.upsert(draft({ label: "A-side" }))
    await book.upsert(draft({ accountNamespace: "acct_b", label: "B-side" }))
    expect((await book.get({ hostId: "host-1", accountNamespace: "acct_b" }))?.label).toBe("B-side")
  })
})

describe("credentials", () => {
  it("round-trips through the secret store, never the record book", async () => {
    const { book, records, credentials } = harness()
    const key = { hostId: "host-1", accountNamespace: "acct_a" }
    await book.upsert(draft())
    await book.saveCredential(key, {
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
    })
    expect(await book.loadCredential(key)).toEqual({
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
    })
    expect(credentials.entries.size).toBe(1)
    expect(JSON.stringify(records.book)).not.toContain("device-private")
  })

  it("returns null when no credential was stored", async () => {
    const { book } = harness()
    expect(await book.loadCredential({ hostId: "x", accountNamespace: "acct_a" })).toBeNull()
  })
})

describe("remove", () => {
  it("drops the credential before the record", async () => {
    const order: string[] = []
    const records = memoryRecords()
    const credentials = memoryCredentials()
    const book = createCredentialBook({
      records: {
        read: records.read,
        write: async (next) => {
          order.push("record")
          await records.write(next)
        },
      },
      credentials: {
        ...credentials,
        remove: async (key) => {
          order.push("credential")
          await credentials.remove(key)
        },
      },
    })
    await book.upsert(draft())
    order.length = 0
    await book.remove({ hostId: "host-1", accountNamespace: "acct_a" })
    expect(order).toEqual(["credential", "record"])
  })

  it("promotes another pairing when the active one is removed", async () => {
    const { book } = harness()
    await book.upsert(draft())
    await book.upsert(draft({ hostId: "host-2", label: "Laptop" }))
    await book.remove({ hostId: "host-1", accountNamespace: "acct_a" })
    expect((await book.getActive("acct_a"))?.hostId).toBe("host-2")
  })

  it("clears the active pointer when the last pairing goes", async () => {
    const { book } = harness()
    await book.upsert(draft())
    await book.remove({ hostId: "host-1", accountNamespace: "acct_a" })
    expect(await book.getActive("acct_a")).toBeNull()
    expect(await book.list()).toEqual([])
  })

  it("leaves another account's pairings alone", async () => {
    const { book } = harness()
    await book.upsert(draft())
    await book.upsert(draft({ accountNamespace: "acct_b" }))
    await book.remove({ hostId: "host-1", accountNamespace: "acct_a" })
    expect(await book.list("acct_b")).toHaveLength(1)
  })

  it("is a no-op for an unknown key", async () => {
    const { book, records, credentials } = harness()
    await book.upsert(draft())
    await credentials.save(
      { hostId: "ghost", accountNamespace: "acct_a" },
      { devicePrivateKeyJwk: { kty: "EC", d: "orphan" } }
    )
    const before = records.writes
    await book.remove({ hostId: "ghost", accountNamespace: "acct_a" })
    expect(records.writes).toBe(before)
    expect(credentials.entries.has("acct_a/ghost")).toBe(false)
  })
})

describe("getActive / setActive", () => {
  it("resolves a single pairing even with no pointer", async () => {
    const records = memoryRecords()
    const credentials = memoryCredentials()
    const book = createCredentialBook({ records, credentials })
    await book.upsert(draft())
    const stored = await records.read()
    stored.active = {}
    await records.write(stored)
    expect((await book.getActive("acct_a"))?.hostId).toBe("host-1")
  })

  it("refuses to guess between two pairings with no pointer", async () => {
    const records = memoryRecords()
    const credentials = memoryCredentials()
    const book = createCredentialBook({ records, credentials })
    await book.upsert(draft())
    await book.upsert(draft({ hostId: "host-2" }))
    const stored = await records.read()
    stored.active = {}
    await records.write(stored)
    expect(await book.getActive("acct_a")).toBeNull()
  })

  it("ignores a dangling pointer", async () => {
    const records = memoryRecords()
    const credentials = memoryCredentials()
    const book = createCredentialBook({ records, credentials })
    await book.upsert(draft())
    const stored = await records.read()
    stored.active.acct_a = "acct_a:gone"
    await records.write(stored)
    expect((await book.getActive("acct_a"))?.hostId).toBe("host-1")
  })

  it("switches the active pairing", async () => {
    const { book } = harness()
    await book.upsert(draft())
    await book.upsert(draft({ hostId: "host-2", label: "Laptop" }))
    await book.setActive({ hostId: "host-2", accountNamespace: "acct_a" })
    expect((await book.getActive("acct_a"))?.hostId).toBe("host-2")
  })

  it("clears only the expected active pointer without deleting the pairing", async () => {
    const records = memoryRecords()
    const credentials = memoryCredentials()
    const book = createCredentialBook({ records, credentials })
    await book.upsert(draft())
    await book.upsert(draft({ hostId: "host-2", label: "Laptop" }))

    await expect(book.clearActive?.("acct_a", "host-2")).rejects.toThrow(/not active/i)
    await book.clearActive?.("acct_a", "host-1")

    const stored = await records.read()
    expect(stored.active.acct_a).toBeUndefined()
    expect(await book.get({ hostId: "host-1", accountNamespace: "acct_a" })).not.toBeNull()
  })

  it("refuses to activate a host that is not paired", async () => {
    const { book } = harness()
    await expect(book.setActive({ hostId: "ghost", accountNamespace: "acct_a" })).rejects.toThrow(
      /No companion host ghost is paired/
    )
  })

  it("returns null for an account with no pairings", async () => {
    const { book } = harness()
    expect(await book.getActive("acct_empty")).toBeNull()
  })
})

describe("updateConnection", () => {
  const key = { hostId: "host-1", accountNamespace: "acct_a" }

  it("increments the generation on every accepted update", async () => {
    const { book } = harness()
    await book.upsert(draft())
    expect((await book.updateConnection(key, { status: "online" })).connection.generation).toBe(1)
    expect((await book.updateConnection(key, { status: "offline" })).connection.generation).toBe(2)
  })

  it("stamps lastOkAt on online and lastErrorAt on offline", async () => {
    const { book } = harness(() => 5_000)
    await book.upsert(draft())
    const online = await book.updateConnection(key, { status: "online" })
    expect(online.connection.lastOkAt).toBe(5_000)
    expect(online.connection.lastErrorAt).toBeNull()
    const offline = await book.updateConnection(key, { status: "offline", lastError: "timeout" })
    expect(offline.connection.lastOkAt).toBe(5_000)
    expect(offline.connection.lastErrorAt).toBe(5_000)
    expect(offline.connection.lastError).toBe("timeout")
  })

  it("stamps lastErrorAt for a revoked pairing too", async () => {
    const { book } = harness(() => 9)
    await book.upsert(draft())
    const revoked = await book.updateConnection(key, { status: "revoked" })
    expect(revoked.connection.lastErrorAt).toBe(9)
  })

  it("honours explicit timestamp overrides", async () => {
    const { book } = harness()
    await book.upsert(draft())
    const updated = await book.updateConnection(key, {
      status: "online",
      lastOkAt: 42,
      lastErrorAt: 7,
      lastError: null,
    })
    expect(updated.connection.lastOkAt).toBe(42)
    expect(updated.connection.lastErrorAt).toBe(7)
    expect(updated.connection.lastError).toBeNull()
  })

  it("rejects a stale generation and leaves the record untouched", async () => {
    const { book } = harness()
    await book.upsert(draft())
    await book.updateConnection(key, { status: "online" })
    await expect(book.updateConnection(key, { status: "offline" }, 0)).rejects.toBeInstanceOf(
      StaleConnectionGenerationError
    )
    expect((await book.get(key))?.connection.status).toBe("online")
  })

  it("accepts a matching generation", async () => {
    const { book } = harness()
    await book.upsert(draft())
    const first = await book.updateConnection(key, { status: "online" })
    const second = await book.updateConnection(
      key,
      { status: "offline" },
      first.connection.generation
    )
    expect(second.connection.status).toBe("offline")
  })

  it("keeps a slow prober from regressing a newer verdict", async () => {
    const { book } = harness()
    await book.upsert(draft())
    const observed = (await book.get(key))!.connection.generation
    // The tunnel prober wins the race…
    await book.updateConnection(key, { status: "online" }, observed)
    // …and the LAN prober, which started at the same generation, is refused.
    await expect(
      book.updateConnection(key, { status: "offline" }, observed)
    ).rejects.toBeInstanceOf(StaleConnectionGenerationError)
    expect((await book.get(key))?.connection.status).toBe("online")
  })

  it("throws for an unknown host", async () => {
    const { book } = harness()
    await expect(
      book.updateConnection({ hostId: "ghost", accountNamespace: "acct_a" }, { status: "online" })
    ).rejects.toThrow(/No companion host ghost is paired/)
  })
})
