import {
  seedTrustedPublishers,
  TRUSTED_PUBLISHER_SEEDS,
  type TrustedPublisherSeed,
  type TrustedPublisherSeedTable,
  type TrustedPublisherSeedTransaction,
} from "./trusted-publishers"
import type { TrustedPublisherRow } from "@/lib/db/schema"

function makeFakeTx(initial: TrustedPublisherRow[] = []): {
  tx: TrustedPublisherSeedTransaction
  store: Map<string, TrustedPublisherRow>
  putCalls: TrustedPublisherRow[]
  tableCalls: number
} {
  const store = new Map<string, TrustedPublisherRow>(initial.map((r) => [r.publicKey, r]))
  const putCalls: TrustedPublisherRow[] = []
  let tableCalls = 0
  const table: TrustedPublisherSeedTable = {
    async get(publicKey) {
      return store.get(publicKey)
    },
    async put(row) {
      store.set(row.publicKey, row)
      putCalls.push(row)
      return row.publicKey
    },
  }
  return {
    tx: {
      table: (_name) => {
        tableCalls += 1
        return table
      },
    },
    store,
    putCalls,
    get tableCalls() {
      return tableCalls
    },
  }
}

describe("TRUSTED_PUBLISHER_SEEDS", () => {
  // The whole point of the v109 trust-model rebuild. The nine
  // `"placeholder:*"` rows this list used to hold were a live vulnerability:
  // the fingerprints were literals in this repo's source, the policy matched
  // them by plain string equality, and a plugin asserted its own fingerprint —
  // so any hostile `.vsix` could name one and spawn its bundled binary with no
  // prompt. `scripts/gates/check-trusted-publishers.ts` is the CI twin of this
  // assertion.
  it("is empty — nothing is trusted by default", () => {
    expect(TRUSTED_PUBLISHER_SEEDS).toEqual([])
  })

  it("contains no placeholder fingerprints", () => {
    const placeholders = TRUSTED_PUBLISHER_SEEDS.filter(
      (s) => s.fingerprint.startsWith("placeholder:") || s.publicKey.startsWith("placeholder:")
    )
    expect(placeholders).toEqual([])
  })

  it("declares no row with placeholder provenance", () => {
    expect(TRUSTED_PUBLISHER_SEEDS.every((s) => s.provenance === "verified")).toBe(true)
  })
})

describe("seedTrustedPublishers", () => {
  it("is a no-op against the real (empty) seed list", async () => {
    const { tx, store } = makeFakeTx()
    const result = await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 0 })
    expect(store.size).toBe(0)
  })

  it("does not even open the table when there is nothing to seed", async () => {
    // The v39 hook still calls this for every database that has yet to reach
    // v39; an empty seed must not touch the store at all.
    const fake = makeFakeTx()
    await seedTrustedPublishers(fake.tx, () => 1)
    expect(fake.tableCalls).toBe(0)
  })

  it("leaves rows the user populated themselves untouched", async () => {
    const userRow: TrustedPublisherRow = {
      publicKey: "MCowBQYDK2VwAyEA-user-supplied-key",
      fingerprint: "9f3a1c8e4b7d2f605a1938e7c4b0d6f2938475610badc0ffee1234567890abcd",
      authorName: "User-Provided Name",
      firstTrustedAt: 999,
      lastSeenAt: 1_000_000,
      installCount: 17,
    }
    const { tx, store, putCalls } = makeFakeTx([userRow])
    await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    expect(store.get(userRow.publicKey)).toEqual(userRow)
    expect(putCalls).toEqual([])
  })

  it("is idempotent — re-running changes nothing", async () => {
    const { tx } = makeFakeTx()
    const first = await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    const second = await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    expect(first).toEqual(second)
  })

  it("defaults the timestamp to Date.now() when no clock is injected", async () => {
    // Exercises the default parameter; with an empty seed the call is still a
    // well-defined no-op.
    const { tx } = makeFakeTx()
    await expect(seedTrustedPublishers(tx)).resolves.toEqual({
      inserted: 0,
      updated: 0,
      skipped: 0,
    })
  })

  // The insert/update logic is retained for a future *verified* row — one
  // bound to a fingerprint the publisher proved possession of, rather than a
  // string it asserted about itself. These tests pin the contract that logic
  // must honour if such a row ever lands, using an injected list rather than
  // mutating the exported constant.
  describe("insert/update contract (exercised with an injected verified seed)", () => {
    const verifiedSeed: TrustedPublisherSeed = {
      publicKey: "MCowBQYDK2VwAyEA-verified-key",
      fingerprint: "1111111111111111111111111111111111111111111111111111111111111111",
      authorName: "Verified Publisher",
      authorEmail: "sec@example.org",
      homepage: "https://example.org",
      firstTrustedAt: 0,
      lastSeenAt: 0,
      installCount: 0,
      provenance: "verified",
    }

    function withSeeds<T>(seeds: TrustedPublisherSeed[], fn: () => Promise<T>): Promise<T> {
      const original = [...TRUSTED_PUBLISHER_SEEDS]
      const mutable = TRUSTED_PUBLISHER_SEEDS as unknown as TrustedPublisherSeed[]
      mutable.length = 0
      mutable.push(...seeds)
      return fn().finally(() => {
        mutable.length = 0
        mutable.push(...original)
      })
    }

    it("inserts a verified row that isn't in the table yet, stamping the seed timestamp", async () => {
      await withSeeds([verifiedSeed], async () => {
        const { tx, store } = makeFakeTx()
        const result = await seedTrustedPublishers(tx, () => 1_700_000_000_000)
        expect(result).toEqual({ inserted: 1, updated: 0, skipped: 0 })
        expect(store.get(verifiedSeed.publicKey)).toEqual({
          publicKey: verifiedSeed.publicKey,
          fingerprint: verifiedSeed.fingerprint,
          authorName: "Verified Publisher",
          authorEmail: "sec@example.org",
          homepage: "https://example.org",
          firstTrustedAt: 1_700_000_000_000,
          lastSeenAt: 1_700_000_000_000,
          installCount: 0,
        })
      })
    })

    it("refreshes a stale fingerprint while preserving the user's usage counters", async () => {
      const stale: TrustedPublisherRow = {
        publicKey: verifiedSeed.publicKey,
        fingerprint: "old-stale-fingerprint",
        authorName: "Verified Publisher",
        firstTrustedAt: 100,
        lastSeenAt: 5_000,
        installCount: 3,
      }
      await withSeeds([verifiedSeed], async () => {
        const { tx, store } = makeFakeTx([stale])
        const result = await seedTrustedPublishers(tx, () => 9_999)
        expect(result).toEqual({ inserted: 0, updated: 1, skipped: 0 })
        const row = store.get(verifiedSeed.publicKey)
        expect(row?.fingerprint).toBe(verifiedSeed.fingerprint)
        // Pre-existing user activity is preserved.
        expect(row?.installCount).toBe(3)
        expect(row?.lastSeenAt).toBe(5_000)
        expect(row?.firstTrustedAt).toBe(100)
      })
    })

    it("skips a row that already carries the verified fingerprint", async () => {
      const current: TrustedPublisherRow = {
        publicKey: verifiedSeed.publicKey,
        fingerprint: verifiedSeed.fingerprint,
        authorName: "Verified Publisher",
        firstTrustedAt: 1,
        lastSeenAt: 2,
        installCount: 4,
      }
      await withSeeds([verifiedSeed], async () => {
        const { tx, putCalls } = makeFakeTx([current])
        const result = await seedTrustedPublishers(tx, () => 9_999)
        expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1 })
        expect(putCalls).toEqual([])
      })
    })

    it("never overwrites an existing row for a non-verified seed", async () => {
      const existing: TrustedPublisherRow = {
        publicKey: verifiedSeed.publicKey,
        fingerprint: "user-chosen-fingerprint",
        authorName: "User",
        firstTrustedAt: 1,
        lastSeenAt: 2,
        installCount: 9,
      }
      await withSeeds([{ ...verifiedSeed, provenance: "placeholder" }], async () => {
        const { tx, store, putCalls } = makeFakeTx([existing])
        const result = await seedTrustedPublishers(tx, () => 9_999)
        expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1 })
        expect(store.get(verifiedSeed.publicKey)).toEqual(existing)
        expect(putCalls).toEqual([])
      })
    })
  })
})
