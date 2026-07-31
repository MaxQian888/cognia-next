/**
 * Trusted-publisher store for CLI GitHub plugin installs. The desktop verifies
 * Ed25519 signatures through a Tauri command (`lib/plugin/security/signature.ts`
 * → `invoke("plugin_verify_signature")`), which the standalone CLI cannot call.
 * GitHub frontend plugins also don't ship signatures, so the meaningful CLI
 * protection is *publisher trust*: the user marks GitHub owners they trust, and
 * the install consent surfaces an "untrusted publisher" warning otherwise.
 *
 * Stored as `~/.cognia/plugin-trust.json` → `{ "owners": ["vercel", ...] }`,
 * mirroring the JSON-file style of `marketplace-sources.ts`. GitHub owner names
 * are case-insensitive, so we normalise to lowercase on write and compare.
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface TrustFs {
  readFileSync: (p: string, enc?: BufferEncoding) => string
  writeFileSync: (p: string, data: string) => void
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void
}

const defaultFs: TrustFs = {
  readFileSync: (p) => nodeFs.readFileSync(p, "utf8"),
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
  mkdirSync: (p, o) => void nodeFs.mkdirSync(p, o),
}

function trustPath(home: string): string {
  return path.join(home, ".cognia", "plugin-trust.json")
}

/** Read the trusted GitHub owners (lowercased). Returns [] on any error. */
export function readTrustedOwners(home: string, fs: TrustFs = defaultFs): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustPath(home), "utf8")) as { owners?: unknown }
    return Array.isArray(parsed.owners)
      ? parsed.owners.filter((o): o is string => typeof o === "string")
      : []
  } catch {
    return []
  }
}

/** Whether a GitHub owner is in the trust list (case-insensitive). */
export function isOwnerTrusted(home: string, owner: string, fs: TrustFs = defaultFs): boolean {
  return readTrustedOwners(home, fs).includes(owner.trim().toLowerCase())
}

function writeOwners(home: string, owners: string[], fs: TrustFs): void {
  fs.mkdirSync(path.join(home, ".cognia"), { recursive: true })
  fs.writeFileSync(trustPath(home), JSON.stringify({ owners }, null, 2))
}

/** Trust a GitHub owner (lowercased, deduped, trimmed). Returns the list. */
export function addTrustedOwner(home: string, owner: string, fs: TrustFs = defaultFs): string[] {
  const o = owner.trim().toLowerCase()
  const current = readTrustedOwners(home, fs)
  if (!o || current.includes(o)) return current
  const next = [...current, o]
  writeOwners(home, next, fs)
  return next
}

/** Revoke trust for a GitHub owner (case-insensitive). Returns the list. */
export function removeTrustedOwner(home: string, owner: string, fs: TrustFs = defaultFs): string[] {
  const o = owner.trim().toLowerCase()
  const next = readTrustedOwners(home, fs).filter((x) => x !== o)
  writeOwners(home, next, fs)
  return next
}
