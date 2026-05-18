import {
  seedTrustedPublishers,
  TRUSTED_PUBLISHER_SEEDS,
  type TrustedPublisherSeedTable,
  type TrustedPublisherSeedTransaction,
} from "./trusted-publishers"
import type { TrustedPublisherRow } from "@/lib/db/schema"

function makeFakeTx(initial: TrustedPublisherRow[] = []): {
  tx: TrustedPublisherSeedTransaction
  store: Map<string, TrustedPublisherRow>
  putCalls: TrustedPublisherRow[]
} {
  const store = new Map<string, TrustedPublisherRow>(initial.map((r) => [r.publicKey, r]))
  const putCalls: TrustedPublisherRow[] = []
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
    tx: { table: (_name) => table },
    store,
    putCalls,
  }
}

describe("seedTrustedPublishers", () => {
  it("inserts every seed row when the table is empty", async () => {
    const { tx, store } = makeFakeTx()
    const result = await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    expect(result.inserted).toBe(TRUSTED_PUBLISHER_SEEDS.length)
    expect(result.updated).toBe(0)
    expect(result.skipped).toBe(0)
    for (const seed of TRUSTED_PUBLISHER_SEEDS) {
      const row = store.get(seed.publicKey)
      expect(row).toBeDefined()
      expect(row?.firstTrustedAt).toBe(1_700_000_000_000)
      expect(row?.lastSeenAt).toBe(1_700_000_000_000)
      expect(row?.installCount).toBe(0)
    }
  })

  it("is idempotent — re-running with no changes inserts nothing", async () => {
    const { tx } = makeFakeTx()
    const first = await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    const second = await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    expect(first.inserted).toBeGreaterThan(0)
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.skipped).toBe(TRUSTED_PUBLISHER_SEEDS.length)
  })

  it("never overwrites a user-trusted row whose fingerprint matches", async () => {
    const userRow: TrustedPublisherRow = {
      publicKey: TRUSTED_PUBLISHER_SEEDS[0].publicKey,
      fingerprint: TRUSTED_PUBLISHER_SEEDS[0].fingerprint,
      authorName: "User-Provided Name",
      firstTrustedAt: 999,
      lastSeenAt: 1_000_000,
      installCount: 17,
    }
    const { tx, store, putCalls } = makeFakeTx([userRow])
    await seedTrustedPublishers(tx, () => 1_700_000_000_000)
    const row = store.get(userRow.publicKey)
    expect(row).toEqual(userRow) // unchanged
    // The seed run never overwrites a placeholder with the same fingerprint.
    expect(putCalls.find((p) => p.publicKey === userRow.publicKey)).toBeUndefined()
  })

  it("preserves installCount + lastSeenAt when a verified seed updates a stale placeholder", async () => {
    const stalePlaceholder: TrustedPublisherRow = {
      publicKey: "placeholder:microsoft.vscode",
      fingerprint: "old-stale-fingerprint",
      authorName: "Microsoft",
      firstTrustedAt: 100,
      lastSeenAt: 5_000,
      installCount: 3,
    }
    const { tx, store } = makeFakeTx([stalePlaceholder])
    // Override the verified flag for one entry to simulate a release-time
    // refresh — we re-import + patch the seed list in-place for the test.
    const original = TRUSTED_PUBLISHER_SEEDS[0]
    const patched = {
      ...original,
      provenance: "verified" as const,
      fingerprint: "new-real-fingerprint",
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(TRUSTED_PUBLISHER_SEEDS as any)[0] = patched
    try {
      const result = await seedTrustedPublishers(tx, () => 9_999)
      expect(result.updated).toBeGreaterThanOrEqual(1)
      const row = store.get(patched.publicKey)
      expect(row?.fingerprint).toBe("new-real-fingerprint")
      // Pre-existing user activity is preserved.
      expect(row?.installCount).toBe(3)
      expect(row?.lastSeenAt).toBe(5_000)
      expect(row?.firstTrustedAt).toBe(100)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(TRUSTED_PUBLISHER_SEEDS as any)[0] = original
    }
  })

  it("every seed row has a unique publicKey (catches duplicates at review time)", () => {
    const keys = TRUSTED_PUBLISHER_SEEDS.map((r) => r.publicKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("every seed row has the structural fields the install dialog renders", () => {
    for (const seed of TRUSTED_PUBLISHER_SEEDS) {
      expect(seed.publicKey).toBeTruthy()
      expect(seed.fingerprint).toBeTruthy()
      expect(seed.authorName).toBeTruthy()
      expect(seed.homepage).toMatch(/^https?:\/\//)
    }
  })
})
