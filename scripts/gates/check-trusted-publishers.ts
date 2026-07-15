/**
 * CI guard: the trusted-publisher seed must never contain placeholder rows.
 *
 * ## What this replaces
 *
 * `lib/db/seed/trusted-publishers.ts` used to reference a
 * `scripts/refresh-trusted-publishers.ts` that would "fetch real fingerprints
 * from each publisher's signing endpoint at release time". That script never
 * existed and cannot be written honestly: Open VSX signs with a single
 * **registry-wide** key (no per-publisher fingerprint exists to fetch), and
 * Microsoft's marketplace ToS forbids non-Microsoft use of its gallery. A
 * script that "refreshed" nine rows it cannot verify would only launder
 * placeholders into something that looks verified.
 *
 * So the seed was emptied, and this validator is what keeps it empty.
 *
 * ## Why it matters
 *
 * A `trustedPublishers` row is a grant of prompt-free `child_process.spawn` to
 * anything that can present the matching fingerprint. When the fingerprint is a
 * `placeholder:` string checked into this repo, "anything" includes every
 * hostile `.vsix` that reads the source — which is exactly the live
 * vulnerability the v109 trust-model rebuild closed. This gate fails the build
 * if such a row ever comes back.
 *
 * It checks the **seed** (the code), not the user's database: a row a user
 * added by hand is their business, and the v109 upgrade hook already purges
 * the placeholder rows earlier versions wrote.
 *
 * Usage:
 *   pnpm audit:trusted-publishers          # exit 0 if green, 1 if red
 *   pnpm audit:trusted-publishers --json   # machine-readable JSON to stdout
 */

import {
  TRUSTED_PUBLISHER_SEEDS,
  type TrustedPublisherSeed,
} from "../../lib/db/seed/trusted-publishers"

/** Fingerprints starting with this marker are structurally unverifiable. */
export const PLACEHOLDER_PREFIX = "placeholder:"

export interface SeedViolation {
  publicKey: string
  fingerprint: string
  /** Which rule the row broke. */
  kind: "placeholder-fingerprint" | "placeholder-public-key" | "placeholder-provenance"
  message: string
}

export interface SeedCheckReport {
  ok: boolean
  seedCount: number
  violations: SeedViolation[]
}

/**
 * Validate a seed list. Exported (and taking its input as a parameter) so the
 * co-located test can exercise the failure paths without mutating the real
 * exported constant.
 */
export function checkTrustedPublisherSeeds(
  seeds: ReadonlyArray<TrustedPublisherSeed> = TRUSTED_PUBLISHER_SEEDS
): SeedCheckReport {
  const violations: SeedViolation[] = []

  for (const seed of seeds) {
    // The fingerprint is the value the policy matched on — the one that
    // actually granted execution. It is the primary thing to forbid.
    if (seed.fingerprint.startsWith(PLACEHOLDER_PREFIX)) {
      violations.push({
        publicKey: seed.publicKey,
        fingerprint: seed.fingerprint,
        kind: "placeholder-fingerprint",
        message: `Seed "${seed.publicKey}" has a placeholder fingerprint (${seed.fingerprint}). A fingerprint in this list grants prompt-free binary execution to anything presenting it; a literal string committed to this repo grants it to everyone.`,
      })
    }
    // A placeholder public key means the row was never bound to a real key,
    // even if someone edited the fingerprint to look plausible.
    if (seed.publicKey.startsWith(PLACEHOLDER_PREFIX)) {
      violations.push({
        publicKey: seed.publicKey,
        fingerprint: seed.fingerprint,
        kind: "placeholder-public-key",
        message: `Seed "${seed.publicKey}" has a placeholder public key. Rows must be bound to a real key with a proof of possession, not a synthesised identifier.`,
      })
    }
    // Self-declared placeholder provenance: honest, and still not shippable.
    if (seed.provenance === "placeholder") {
      violations.push({
        publicKey: seed.publicKey,
        fingerprint: seed.fingerprint,
        kind: "placeholder-provenance",
        message: `Seed "${seed.publicKey}" declares provenance "placeholder". Only fingerprints verified by a mechanism stronger than self-assertion may ship.`,
      })
    }
  }

  return { ok: violations.length === 0, seedCount: seeds.length, violations }
}

/** Human-readable report. */
export function renderReport(report: SeedCheckReport): string {
  if (report.ok) {
    return `check:trusted-publishers — OK (${report.seedCount} seed row(s), 0 placeholders)`
  }
  const lines = [
    `check:trusted-publishers — FAILED (${report.violations.length} violation(s) across ${report.seedCount} seed row(s))`,
    "",
    ...report.violations.map((v) => `  ✗ [${v.kind}] ${v.message}`),
    "",
    "A trusted-publisher row grants prompt-free child_process.spawn. Remove the",
    "row, or bind it to a fingerprint the publisher proved possession of.",
    "See lib/db/seed/trusted-publishers.ts for why the placeholders were deleted.",
  ]
  return lines.join("\n")
}

function main(): void {
  const wantJson = process.argv.includes("--json")
  const report = checkTrustedPublisherSeeds()
  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  } else {
    process.stdout.write(renderReport(report) + "\n")
  }
  process.exit(report.ok ? 0 : 1)
}

if (require.main === module) {
  main()
}
