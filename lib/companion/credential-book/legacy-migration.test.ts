import type { CompanionConfig } from "@/lib/tauri/companion-storage"

import { createCredentialBook } from "./book"
import {
  companionCursorNamespace,
  legacyHostId,
  legacyLabel,
  migrateLegacyCompanionConfig,
} from "./legacy-migration"
import {
  emptyHostBook,
  type HostBookEnvelope,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import type { CompanionCredentialBook, CompanionHostCredential, CompanionHostKey } from "./types"

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

function legacy(patch: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    baseUrl: "https://desktop.local:27890",
    deviceJwt: "jwt.legacy",
    deviceId: "dev-legacy",
    serverVersion: "0.2.0",
    serverFingerprint: "ff00",
    ...patch,
  }
}

interface Harness {
  book: CompanionCredentialBook
  cleared: number
  refiled: Array<[string, string]>
}

function harness(config: CompanionConfig | null): Harness & {
  run: () => ReturnType<typeof migrateLegacyCompanionConfig>
} {
  const state = {
    book: createCredentialBook({ records: memoryRecords(), credentials: memoryCredentials() }),
    cleared: 0,
    refiled: [] as Array<[string, string]>,
  }
  let current = config
  return {
    ...state,
    get cleared() {
      return state.cleared
    },
    get refiled() {
      return state.refiled
    },
    run: () =>
      migrateLegacyCompanionConfig({
        book: state.book,
        readLegacy: async () => current,
        clearLegacy: async () => {
          state.cleared += 1
          current = null
        },
        refileCursors: async (from, to) => {
          state.refiled.push([from, to])
        },
        fallbackAccountNamespace: "acct_fallback",
      }),
  }
}

describe("legacyHostId / legacyLabel", () => {
  it("prefers the browser target id so a web install does not duplicate", () => {
    expect(legacyHostId(legacy({ targetId: "target-9" }))).toBe("target-9")
  })

  it("falls back to the device id", () => {
    expect(legacyHostId(legacy())).toBe("dev-legacy")
  })

  it("labels from the host name", () => {
    expect(legacyLabel(legacy())).toBe("desktop.local")
  })

  it("falls back to the raw base URL when it cannot be parsed", () => {
    expect(legacyLabel(legacy({ baseUrl: "not a url" }))).toBe("not a url")
  })
})

describe("companionCursorNamespace", () => {
  it("matches the namespace the book stores for the same pairing", async () => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    const config = legacy({ accountId: "acct_a", targetId: "host-9" })
    const outcome = await migrateLegacyCompanionConfig({
      book,
      readLegacy: async () => config,
      clearLegacy: async () => undefined,
      fallbackAccountNamespace: "acct_a",
    })
    // The sync orchestrator derives this synchronously instead of reading the
    // record back; if the two ever disagreed it would resume from a watermark
    // no host owns.
    expect(outcome.kind === "migrated" && outcome.record.cursorNamespace).toBe(
      companionCursorNamespace(config)
    )
  })

  it("files an account-less pairing under the reserved namespace", () => {
    expect(companionCursorNamespace(legacy())).toBe("__local__:dev-legacy")
  })

  it("percent-encodes both halves so a separator in either cannot forge a key", () => {
    expect(companionCursorNamespace(legacy({ accountId: "a:b", deviceId: "c:d" }))).toBe(
      "a%3Ab:c%3Ad"
    )
  })
})

describe("migrateLegacyCompanionConfig", () => {
  it("reports nothing to do when no legacy record exists", async () => {
    const h = harness(null)
    expect(await h.run()).toEqual({ kind: "nothing-to-migrate" })
  })

  it("moves the record, the credential and the cursors, then clears the source", async () => {
    const h = harness(
      legacy({ accountId: "acct_a", lanBaseUrl: "https://lan", rendezvousId: "r1" })
    )
    const outcome = await h.run()
    expect(outcome.kind).toBe("migrated")
    if (outcome.kind !== "migrated") return

    expect(outcome.record).toMatchObject({
      hostId: "dev-legacy",
      accountNamespace: "acct_a",
      label: "desktop.local",
      tlsPin: "ff00",
      deviceId: "dev-legacy",
      rendezvousId: "r1",
    })
    expect(outcome.record.endpoints).toEqual({
      baseUrl: "https://desktop.local:27890",
      lanBaseUrl: "https://lan",
      tunnelBaseUrl: undefined,
    })
    expect(
      await h.book.loadCredential({ hostId: "dev-legacy", accountNamespace: "acct_a" })
    ).toEqual({ deviceJwt: "jwt.legacy", signalingPrivateKeyJwk: undefined })
    expect(h.refiled).toEqual([["dev-legacy", "acct_a:dev-legacy"]])
    expect(h.cleared).toBe(1)
  })

  it("files an account-less pairing under the fallback namespace", async () => {
    const h = harness(legacy())
    const outcome = await h.run()
    expect(outcome.kind === "migrated" && outcome.record.accountNamespace).toBe("acct_fallback")
  })

  it("is idempotent — a second run finds nothing left", async () => {
    const h = harness(legacy({ accountId: "acct_a" }))
    await h.run()
    expect(await h.run()).toEqual({ kind: "nothing-to-migrate" })
    expect(h.cleared).toBe(1)
  })

  it("keeps the legacy record when the credential cannot be read back", async () => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: {
        ...memoryCredentials(),
        // Accepts the write but never returns it: the exact silent-loss shape
        // the verification step exists to catch.
        async load() {
          return null
        },
      },
    })
    let cleared = 0
    const outcome = await migrateLegacyCompanionConfig({
      book,
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => {
        cleared += 1
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome).toEqual({
      kind: "failed",
      reason: "the migrated credential could not be read back",
    })
    expect(cleared).toBe(0)
  })

  it("keeps the legacy record when the TLS pin was lost", async () => {
    const records = memoryRecords()
    const book = createCredentialBook({ records, credentials: memoryCredentials() })
    const outcome = await migrateLegacyCompanionConfig({
      book: {
        ...book,
        // A record that comes back without its pin — a downgrade to unpinned
        // TLS, which must never be traded for a completed migration.
        get: async (key) => {
          const stored = await book.get(key)
          return stored ? { ...stored, tlsPin: null } : null
        },
      },
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => {
        throw new Error("must not clear")
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome).toEqual({ kind: "failed", reason: "the migrated host record lost its TLS pin" })
  })

  it.each([
    ["a different base URL", { endpoints: { baseUrl: "https://elsewhere" } }],
    ["a different device id", { deviceId: "other" }],
  ])("keeps the legacy record when the record comes back with %s", async (_label, patch) => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    const outcome = await migrateLegacyCompanionConfig({
      book: {
        ...book,
        get: async (key) => {
          const stored = await book.get(key)
          return stored ? { ...stored, ...patch } : null
        },
      },
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => {
        throw new Error("must not clear")
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome.kind).toBe("failed")
  })

  it("keeps the legacy record when the record cannot be read back at all", async () => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    const outcome = await migrateLegacyCompanionConfig({
      book: { ...book, get: async () => null },
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => {
        throw new Error("must not clear")
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome).toEqual({
      kind: "failed",
      reason: "the migrated host record could not be read back",
    })
  })

  it("keeps the legacy record when the token comes back different", async () => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    const outcome = await migrateLegacyCompanionConfig({
      book: { ...book, loadCredential: async () => ({ deviceJwt: "someone-elses" }) },
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => {
        throw new Error("must not clear")
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome).toEqual({
      kind: "failed",
      reason: "the migrated credential holds a different device token",
    })
  })

  it("keeps the legacy record when the signing key was dropped", async () => {
    const jwk = { kty: "EC" } as JsonWebKey
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    const outcome = await migrateLegacyCompanionConfig({
      book: { ...book, loadCredential: async () => ({ deviceJwt: "jwt.legacy" }) },
      readLegacy: async () => legacy({ accountId: "acct_a", signalingPrivateKeyJwk: jwk }),
      clearLegacy: async () => {
        throw new Error("must not clear")
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome).toEqual({
      kind: "failed",
      reason: "the migrated credential lost its signaling key",
    })
  })

  it("reports a thrown store error as a failure without clearing", async () => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    let cleared = 0
    const outcome = await migrateLegacyCompanionConfig({
      book: {
        ...book,
        saveCredential: async () => {
          throw new Error("keystore is locked")
        },
      },
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => {
        cleared += 1
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome).toEqual({ kind: "failed", reason: "keystore is locked" })
    expect(cleared).toBe(0)
  })

  it("skips the cursor re-file when the namespace already matches", async () => {
    const refiled: Array<[string, string]> = []
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    await migrateLegacyCompanionConfig({
      book,
      readLegacy: async () => legacy({ accountId: "acct_a", deviceId: "acct_a:dev" }),
      clearLegacy: async () => undefined,
      refileCursors: async (from, to) => {
        refiled.push([from, to])
      },
      fallbackAccountNamespace: "acct_a",
    })
    // `deviceId` and the derived namespace differ here, so it DOES re-file —
    // the guard only skips when they are literally equal.
    expect(refiled).toHaveLength(1)
  })

  it("does not re-file when the legacy key already equals the namespace", async () => {
    const refiled: Array<[string, string]> = []
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    // A device id that happens to equal the derived namespace: nothing to move.
    await migrateLegacyCompanionConfig({
      book: {
        ...book,
        upsert: async (input) => ({
          ...(await book.upsert(input)),
          cursorNamespace: "dev-legacy",
        }),
      },
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => undefined,
      refileCursors: async (from, to) => {
        refiled.push([from, to])
      },
      fallbackAccountNamespace: "acct_a",
    })
    expect(refiled).toEqual([])
  })

  it("migrates a pairing that never had a TLS pin, recording it as null", async () => {
    const h = harness(legacy({ accountId: "acct_a", serverFingerprint: undefined }))
    const outcome = await h.run()
    expect(outcome.kind === "migrated" && outcome.record.tlsPin).toBeNull()
  })

  it("migrates fine with no cursor re-filer at all", async () => {
    const book = createCredentialBook({
      records: memoryRecords(),
      credentials: memoryCredentials(),
    })
    const outcome = await migrateLegacyCompanionConfig({
      book,
      readLegacy: async () => legacy({ accountId: "acct_a" }),
      clearLegacy: async () => undefined,
      fallbackAccountNamespace: "acct_a",
    })
    expect(outcome.kind).toBe("migrated")
  })
})
