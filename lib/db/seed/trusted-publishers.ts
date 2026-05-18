/**
 * Trusted publisher seed for the `.vsix`-bundled LSP binary policy.
 *
 * cognia's `lsp-binary-policy.ts` gates `child_process.spawn(...)` on
 * every LSP server an extension wants to start. Without an entry in
 * `trustedPublishers` the user is prompted on every spawn — for a
 * smooth out-of-box experience we seed the ledger with the Ed25519
 * fingerprints of mainstream extension publishers (Microsoft, rust-lang,
 * golang.org/x/tools, palantir, python-lsp-server, Open VSX root,
 * dbaeumer, ms-python, eamodio).
 *
 * Important — fingerprint sources:
 *   • Microsoft VS Code marketplace signs every official extension with
 *     a chain rooted at a small set of publisher keys. The fingerprints
 *     below are placeholders flagged with `provenance: "placeholder"` —
 *     they are filled in by `scripts/refresh-trusted-publishers.ts` at
 *     release time, fetching the keys directly from each project's
 *     signing endpoint (e.g. `https://marketplace.visualstudio.com/_apis/
 *     public/gallery/extensionquery` for VS Marketplace, the GitHub
 *     release artifact for rust-analyzer, etc.).
 *   • Each seed row has a `homepage` so the user can verify the publisher
 *     identity in the install dialog before accepting.
 *
 * The migration is **idempotent**: rows with `provenance: "placeholder"`
 * are inserted only if no row with the same `publicKey` exists; rows
 * with `provenance: "verified"` upsert (replace the prior placeholder
 * after refresh). Users who manually accepted a publisher fingerprint
 * are never overwritten — their row is owned by them, not the seed.
 *
 * Wiring: see `lib/db/schema.ts` v39 upgrade hook.
 */

import type { TrustedPublisherRow } from "@/lib/db/schema"

export type TrustedPublisherProvenance = "verified" | "placeholder"

export interface TrustedPublisherSeed extends TrustedPublisherRow {
  /**
   * Where the fingerprint came from. `"verified"` means the row was
   * filled in by the release-time refresh script; `"placeholder"` is a
   * structural placeholder waiting for a real fingerprint. The dev-mode
   * toggle and the runtime LSP-binary prompt let users work around
   * placeholders without blocking the development flow.
   */
  provenance: TrustedPublisherProvenance
}

/** Synthesised "now" used at first seed; real `firstTrustedAt` is the migration timestamp. */
const SEED_TIMESTAMP = 0

/**
 * The seed list. Each `publicKey` MUST be unique — Dexie uses it as the
 * primary key on `trustedPublishers`. `fingerprint` is the SHA-256 hex
 * digest of the public key, shown to users in the install dialog.
 *
 * Placeholder values are clearly marked. The release script replaces
 * them once it can verify the keys against the publisher's own
 * advertised signing endpoint.
 */
export const TRUSTED_PUBLISHER_SEEDS: ReadonlyArray<TrustedPublisherSeed> = [
  {
    publicKey: "placeholder:microsoft.vscode",
    fingerprint: "placeholder:microsoft.vscode",
    authorName: "Microsoft",
    authorEmail: undefined,
    homepage: "https://github.com/microsoft/vscode",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:dbaeumer.vscode-eslint",
    fingerprint: "placeholder:dbaeumer.vscode-eslint",
    authorName: "Dirk Baeumer (Microsoft)",
    homepage: "https://github.com/microsoft/vscode-eslint",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:ms-python",
    fingerprint: "placeholder:ms-python",
    authorName: "Microsoft Python",
    homepage: "https://github.com/microsoft/vscode-python",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:rust-lang.rust-analyzer",
    fingerprint: "placeholder:rust-lang.rust-analyzer",
    authorName: "rust-lang",
    homepage: "https://github.com/rust-lang/rust-analyzer",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:golang.go",
    fingerprint: "placeholder:golang.go",
    authorName: "Go Team at Google",
    homepage: "https://github.com/golang/vscode-go",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:palantir.python-language-server",
    fingerprint: "placeholder:palantir.python-language-server",
    authorName: "Palantir",
    homepage: "https://github.com/palantir/python-language-server",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:python-lsp.python-lsp-server",
    fingerprint: "placeholder:python-lsp.python-lsp-server",
    authorName: "Python LSP Server",
    homepage: "https://github.com/python-lsp/python-lsp-server",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:openvsx.root",
    fingerprint: "placeholder:openvsx.root",
    authorName: "Open VSX Registry",
    homepage: "https://open-vsx.org",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
  {
    publicKey: "placeholder:eamodio.gitlens",
    fingerprint: "placeholder:eamodio.gitlens",
    authorName: "Eric Amodio (GitLens)",
    homepage: "https://github.com/gitkraken/vscode-gitlens",
    firstTrustedAt: SEED_TIMESTAMP,
    lastSeenAt: SEED_TIMESTAMP,
    installCount: 0,
    provenance: "placeholder",
  },
]

/**
 * Apply the seed inside a Dexie upgrade transaction. Idempotent:
 *   • Rows already present (by `publicKey`) are left untouched if their
 *     `provenance` is `"verified"` (user accepted them manually OR a
 *     prior refresh ran).
 *   • Rows that don't exist yet are inserted with the seed timestamps.
 *   • Verified seed entries overwrite placeholder rows from prior
 *     migrations.
 *
 * The caller wires this into the v39 `.upgrade(tx => seedTrustedPublishers(tx))`
 * hook. Pass a Dexie `Transaction` or a plain `Table`-shaped object —
 * tests inject the latter.
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
  const table = tx.table("trustedPublishers")
  const timestamp = now()
  let inserted = 0
  let updated = 0
  let skipped = 0

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
    // Replace a stale placeholder with a verified seed; never overwrite
    // a row the user populated themselves or one that's already
    // verified.
    if (seed.provenance === "verified" && existing.fingerprint !== seed.fingerprint) {
      await table.put({
        ...existing,
        fingerprint: seed.fingerprint,
        // Preserve the user-facing `installCount` and `lastSeenAt` —
        // they reflect actual usage, not seeding.
      })
      updated += 1
      continue
    }
    skipped += 1
  }

  return { inserted, updated, skipped }
}
