/**
 * Trusted-publisher seed — **intentionally empty**.
 *
 * ## Why there is nothing to seed
 *
 * This module used to seed nine rows into `trustedPublishers` (Microsoft,
 * rust-lang, golang, palantir, python-lsp, Open VSX root, dbaeumer, ms-python,
 * eamodio), each with a `fingerprint` of `"placeholder:<publisher>"` and a
 * header comment promising that `scripts/refresh-trusted-publishers.ts` would
 * fill in real keys at release time.
 *
 * That script never existed, and it **cannot be written honestly**:
 *   • Open VSX signs with a single **registry-wide** key — `ms-python` and
 *     `rust-lang` return the same key uuid. There is no per-publisher
 *     fingerprint to fetch, so there is nothing to refresh.
 *   • Microsoft's marketplace ToS restricts its use to Microsoft's own
 *     products, so the `microsoft.*` / `ms-python` / `dbaeumer` rows could
 *     never be filled from the source they claimed.
 *   • `rust-lang` / `golang.go` / `eamodio` publish no Ed25519 extension
 *     signing key on a stable endpoint; `palantir/python-language-server` is
 *     archived upstream.
 *
 * Meanwhile the placeholders were not inert — they were exploitable. The old
 * policy granted a prompt-free `child_process.spawn` when a plugin's manifest
 * asserted a `publisherKeyFingerprint` matching a `trustedPublishers` row by
 * **plain string equality with zero cryptography**. Those placeholder strings
 * are in this repo's git history, so any hostile `.vsix` could self-declare
 * `"placeholder:microsoft.vscode"` and execute its own bundled binary
 * silently. `"placeholder:openvsx.root"` was the worst of the nine: it would
 * have made **every** Open VSX extension's binary auto-spawnable.
 *
 * A script that "refreshed" rows it cannot verify would have laundered the
 * placeholders into something that *looks* verified — strictly worse than the
 * honest `provenance: "placeholder"` marker. So the seed is empty instead, and
 * `scripts/check-trusted-publishers.ts` is the CI guard that keeps it that way.
 *
 * ## The model that replaced it
 *
 * Trust is no longer asserted by the code being trusted. `approvedBinaries`
 * (v109, `lib/db/approved-binaries.ts`) records that **this user** approved
 * **these exact bytes** (SHA-256) at **this exact path** for **this plugin**.
 * The binary-spawn policies re-hash the file on every evaluation, so any drift
 * re-prompts. The consequence is deliberate: **every** plugin-shipped binary
 * prompts on first execution. That is the only default we can state honestly.
 *
 * ## Why this module still exists
 *
 * `seedTrustedPublishers` stays wired into the v39 upgrade hook, which is
 * immutable history — Dexie replays the whole chain, so the hook must keep
 * resolving for every database that has yet to reach v39. With an empty seed
 * list it is a well-defined no-op. The v109 hook deletes the placeholder rows
 * that earlier openings already wrote.
 *
 * `trustedPublishers` itself is retained: rows a user populated by hand are
 * their data, and the table may yet back a real proof-of-possession scheme
 * (one where the publisher signs a challenge rather than naming itself).
 * Nothing reads it for spawn decisions today.
 *
 * Wiring: `lib/db/schema.ts` v39 (seed) + v109 (placeholder purge).
 */

import type { TrustedPublisherRow } from "@/lib/db/schema"

export type TrustedPublisherProvenance = "verified" | "placeholder"

export interface TrustedPublisherSeed extends TrustedPublisherRow {
  /**
   * Where the fingerprint came from. Only `"verified"` — a fingerprint proven
   * to belong to the publisher by a mechanism stronger than the publisher
   * saying so — may ever appear in this list. `"placeholder"` remains in the
   * union solely so `scripts/check-trusted-publishers.ts` can name the thing
   * it forbids.
   */
  provenance: TrustedPublisherProvenance
}

/**
 * The seed list — **empty, and required to stay that way**.
 *
 * Adding a row here grants prompt-free binary execution to everything that can
 * present the matching fingerprint. Do not add one unless the fingerprint is
 * bound to a *proof of possession* (the publisher demonstrating control of the
 * private key), not to a self-declared string in a manifest. `placeholder:`
 * entries are rejected outright by `scripts/check-trusted-publishers.ts`.
 */
export const TRUSTED_PUBLISHER_SEEDS: ReadonlyArray<TrustedPublisherSeed> = []

/**
 * Apply the seed inside a Dexie upgrade transaction. Idempotent.
 *
 * With an empty `TRUSTED_PUBLISHER_SEEDS` this is a no-op that returns all
 * zeroes. The insert/update logic is retained because it is the contract the
 * v39 hook was written against, and because a future *verified* row must
 * behave exactly as documented: never clobber a row the user populated
 * themselves.
 *
 * Pass a Dexie `Transaction` or a plain `Table`-shaped object — tests inject
 * the latter.
 */
export interface TrustedPublisherSeedTable {
  get(publicKey: string): Promise<TrustedPublisherRow | undefined>
  put(row: TrustedPublisherRow): Promise<unknown>
}

export interface TrustedPublisherSeedTransaction {
  table(name: "trustedPublishers"): TrustedPublisherSeedTable
}

export async function seedTrustedPublishers(
  tx: TrustedPublisherSeedTransaction,
  /** Override timestamp for tests; defaults to `Date.now()` at apply time. */
  now: () => number = Date.now
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0
  let updated = 0
  let skipped = 0

  if (TRUSTED_PUBLISHER_SEEDS.length === 0) {
    // No rows to seed — don't touch the table at all.
    return { inserted, updated, skipped }
  }

  const table = tx.table("trustedPublishers")
  const timestamp = now()

  for (const seed of TRUSTED_PUBLISHER_SEEDS) {
    const existing = await table.get(seed.publicKey)
    if (!existing) {
      await table.put({
        publicKey: seed.publicKey,
        fingerprint: seed.fingerprint,
        authorName: seed.authorName,
        authorEmail: seed.authorEmail,
        homepage: seed.homepage,
        firstTrustedAt: timestamp,
        lastSeenAt: timestamp,
        installCount: 0,
      })
      inserted += 1
      continue
    }
    // Replace a stale row with a verified seed; never overwrite a row the
    // user populated themselves or one that's already verified.
    if (seed.provenance === "verified" && existing.fingerprint !== seed.fingerprint) {
      await table.put({
        ...existing,
        fingerprint: seed.fingerprint,
        // Preserve the user-facing `installCount` and `lastSeenAt` — they
        // reflect actual usage, not seeding.
      })
      updated += 1
      continue
    }
    skipped += 1
  }

  return { inserted, updated, skipped }
}
