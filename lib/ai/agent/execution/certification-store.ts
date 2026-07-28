// Certification bundle store (ADR-0090 Phase 5).
//
// Authority = signed manifest FILES under
//   <dataDir>/agent-certification/bundles/<bundleId>/manifest.json
// with a CAS-written `active-bundle.json` pointer and an UNSIGNED
// `health.json` overlay (per-capability circuit state — down-rank input
// only, never up-rank). Desktop and headless share the layout; Dexie holds
// only a rebuildable projection.
//
// The filesystem is injected so the same port serves the Tauri fs surface,
// plain node fs (headless), and tests.

import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import {
  manifestSigningPayload,
  validateCompatibilityManifest,
} from "@cognia/agent-config-types/compatibility-manifest"

export interface CertificationFs {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  listDir(path: string): Promise<string[]>
}

export interface ActiveBundlePointer {
  bundleId: string
  activatedAt: string
  previousBundleId?: string
}

export interface CapabilityHealthEntry {
  keyId: string
  capability: string
  consecutiveFailures: number
  /** ISO time until which the capability circuit is open. */
  openUntil?: string
}

/**
 * Cognia release verification key (Ed25519, SPKI/PEM). Verify-only — the
 * signing half lives exclusively in CI secrets (emit-manifest). The `local`
 * issuer signs with an ad-hoc key whose public half is embedded in the
 * manifest bundle for dev round-trips; managed policy can require
 * `issuer: "cognia-ci"` and this key.
 */
export const COGNIA_RELEASE_PUBKEY_PEM = process.env.NEXT_PUBLIC_COGNIA_CERT_PUBKEY ?? ""

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function decodePublicKeyPem(publicKeyPem: string): Uint8Array<ArrayBuffer> {
  const encoded = publicKeyPem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "")
  return decodeBase64(encoded)
}

export class CertificationStore {
  constructor(
    private readonly fs: CertificationFs,
    private readonly rootDir: string
  ) {}

  private bundleDir(bundleId: string): string {
    return `${this.rootDir}/bundles/${bundleId}`
  }

  async listBundles(): Promise<string[]> {
    try {
      return (await this.fs.listDir(`${this.rootDir}/bundles`)).sort()
    } catch {
      return []
    }
  }

  async readManifest(bundleId: string): Promise<CompatibilityManifest | null> {
    const raw = await this.fs.readFile(`${this.bundleDir(bundleId)}/manifest.json`)
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    const validated = validateCompatibilityManifest(parsed)
    return validated.ok ? validated.value : null
  }

  /**
   * Verify the manifest's Ed25519 signature against a PEM public key.
   * Unsigned manifests never verify.
   */
  async verifySignature(manifest: CompatibilityManifest, publicKeyPem: string): Promise<boolean> {
    if (!manifest.signature || !publicKeyPem) return false
    try {
      const key = await globalThis.crypto.subtle.importKey(
        "spki",
        decodePublicKeyPem(publicKeyPem),
        { name: "Ed25519" },
        false,
        ["verify"]
      )
      return globalThis.crypto.subtle.verify(
        "Ed25519",
        key,
        decodeBase64(manifest.signature),
        new TextEncoder().encode(manifestSigningPayload(manifest))
      )
    } catch {
      return false
    }
  }

  async getActiveBundle(): Promise<ActiveBundlePointer | null> {
    const raw = await this.fs.readFile(`${this.rootDir}/active-bundle.json`)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as ActiveBundlePointer
      return typeof parsed.bundleId === "string" ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * CAS-activate a bundle: the caller passes the pointer it READ
   * (`expected`, null for "none"); a concurrent activation in between makes
   * this throw instead of last-writer-wins.
   */
  async activateBundle(
    bundleId: string,
    expected: ActiveBundlePointer | null
  ): Promise<ActiveBundlePointer> {
    const manifest = await this.readManifest(bundleId)
    if (!manifest) throw new Error(`bundle ${bundleId} has no valid manifest`)
    const current = await this.getActiveBundle()
    if ((current?.bundleId ?? null) !== (expected?.bundleId ?? null)) {
      throw new Error(
        `activation conflict: expected active=${expected?.bundleId ?? "none"}, found ${current?.bundleId ?? "none"}`
      )
    }
    const next: ActiveBundlePointer = {
      bundleId,
      activatedAt: new Date().toISOString(),
      ...(current ? { previousBundleId: current.bundleId } : {}),
    }
    await this.fs.writeFile(`${this.rootDir}/active-bundle.json`, JSON.stringify(next, null, 2))
    return next
  }

  /** Roll back to the pointer's previousBundleId (verified first). */
  async rollback(): Promise<ActiveBundlePointer> {
    const current = await this.getActiveBundle()
    if (!current?.previousBundleId) {
      throw new Error("no previous bundle recorded — nothing to roll back to")
    }
    return this.activateBundle(current.previousBundleId, current)
  }

  // ---- Unsigned health overlay (down-rank only) ---------------------------

  async readHealth(): Promise<CapabilityHealthEntry[]> {
    const raw = await this.fs.readFile(`${this.rootDir}/health.json`)
    if (raw === null) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async writeHealth(entries: CapabilityHealthEntry[]): Promise<void> {
    await this.fs.writeFile(`${this.rootDir}/health.json`, JSON.stringify(entries, null, 2))
  }
}
