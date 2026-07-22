/**
 * Plugin Signature Verification
 *
 * Verifies plugin authenticity and integrity using digital signatures.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform/detect"
import { loggers } from "../core/logger"
import { recordSilentFailure } from "../contracts/diagnostics-store"

// =============================================================================
// Types
// =============================================================================

export interface PluginSignature {
  pluginId: string
  version: string
  algorithm: "ed25519" | "rsa-sha256"
  signature: string
  publicKey: string
  signedAt: Date
  expiresAt?: Date
}

export interface SignatureVerificationResult {
  valid: boolean
  pluginId: string
  version: string
  signer?: SignerInfo
  reason?: string
  warnings: string[]
}

export interface SignerInfo {
  name: string
  email?: string
  organization?: string
  verified: boolean
  trustedLevel: TrustLevel
}

export type TrustLevel = "official" | "verified" | "community" | "unknown" | "untrusted"

export interface TrustedPublisher {
  id: string
  name: string
  publicKey: string
  trustLevel: TrustLevel
  addedAt: Date
  domains?: string[]
}

export interface SignatureConfig {
  requireSignatures: boolean
  allowUntrusted: boolean
  trustedPublishersOnly: boolean
  verifyOnLoad: boolean
  cacheVerifications: boolean
}

/**
 * Host-written attestation of HOW a plugin's install bytes were validated,
 * persisted by `install_archive_into_plugin_dir` and read back via the
 * `plugin_read_verification` Tauri command. `signature` means an Ed25519
 * provenance signature was verified against the archive; `checksum` means only
 * SHA-256 integrity was confirmed. Absent → the install never cleared an
 * integrity check (e.g. a local/dev install).
 */
export interface PluginVerificationReceipt {
  verifiedVia: "signature" | "checksum"
  version: string
  verifiedAt: string
}

const USER_PUBLISHERS_STORAGE_KEY = "plugin:security:user-publishers"

/**
 * Official Cognia plugin-signing public key (base64 Ed25519). Injected at
 * BUILD TIME via `NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY` so the private key never
 * lives in the repo — the maintainer holds it and signs first-party plugins
 * out-of-band (see `docs/content/docs/en/plugins/plugin-signing.md`). Empty =
 * not yet configured.
 */
export const OFFICIAL_PLUGIN_PUBLIC_KEY: string = (
  process.env.NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY ?? ""
).trim()

/** True once a real official publisher key has been injected at build time. */
export function isOfficialPublisherKeyConfigured(): boolean {
  return OFFICIAL_PLUGIN_PUBLIC_KEY.length > 0
}

// When the official key has NOT been configured we deliberately seed NO
// official publisher. Previously this carried `publicKey: ""`, which made any
// signature claiming an empty public key match the "official" anchor — a
// spoofable trust hole. With no anchor, `trustedPublishersOnly` correctly
// rejects everything until a real key is injected.
const OFFICIAL_TRUSTED_PUBLISHERS: TrustedPublisher[] = isOfficialPublisherKeyConfigured()
  ? [
      {
        id: "cognia-official",
        name: "Cognia Official",
        publicKey: OFFICIAL_PLUGIN_PUBLIC_KEY,
        trustLevel: "official",
        addedAt: new Date("2024-01-01T00:00:00.000Z"),
        domains: ["cognia.app"],
      },
    ]
  : []

// =============================================================================
// Signature Verifier
// =============================================================================

export class PluginSignatureVerifier {
  private config: SignatureConfig
  private trustedPublishers: Map<string, TrustedPublisher> = new Map()
  private verificationCache: Map<string, SignatureVerificationResult> = new Map()

  constructor(config: Partial<SignatureConfig> = {}) {
    this.config = {
      // ADR 0016 P0-3 (2026-05-17) — default-on. Production installs require a
      // verified signature unless the user explicitly disables the policy via
      // Settings → Plugins → Policy. Tests can opt out by passing
      // `requireSignatures: false` explicitly.
      requireSignatures: true,
      allowUntrusted: true,
      trustedPublishersOnly: false,
      verifyOnLoad: true,
      cacheVerifications: true,
      ...config,
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async initialize(): Promise<void> {
    await this.loadTrustedPublishers()
  }

  private async loadTrustedPublishers(): Promise<void> {
    try {
      this.trustedPublishers.clear()

      for (const publisher of OFFICIAL_TRUSTED_PUBLISHERS) {
        this.trustedPublishers.set(publisher.id, {
          ...publisher,
          addedAt: new Date(publisher.addedAt),
        })
      }

      const userPublishers = this.readUserPublishersFromStorage()
      for (const publisher of userPublishers) {
        this.trustedPublishers.set(publisher.id, {
          ...publisher,
          addedAt: new Date(publisher.addedAt),
        })
      }
    } catch (error) {
      loggers.manager.warn("[Signature] Failed to load trusted publishers:", error)
    }
  }

  // ===========================================================================
  // Verification
  // ===========================================================================

  async verify(pluginPath: string): Promise<SignatureVerificationResult> {
    // Check cache first
    if (this.config.cacheVerifications) {
      const cached = this.verificationCache.get(pluginPath)
      if (cached) return cached
    }

    const warnings: string[] = []

    // The AUTHORITATIVE integrity + signature check for marketplace/github
    // bundles runs host-side over the raw archive bytes
    // (`verify_download_integrity` in src-tauri) BEFORE anything is written to
    // disk, and its outcome is persisted as a per-plugin verification receipt.
    // When the policy requires signatures, consult that receipt (via
    // `plugin_read_verification`): an install passes only if the host verified
    // a real Ed25519 provenance signature. A checksum-only or absent receipt
    // (e.g. a local/dev install) is rejected. WASM bundles use the separate
    // detached-signature path (`verifyDetachedBundleSignature`).
    if (this.config.requireSignatures) {
      const receipt = await this.readVerificationReceipt(pluginPath)
      if (receipt?.verifiedVia === "signature") {
        return this.createResult(pluginPath, true, undefined, warnings)
      }
      const reason = receipt
        ? `Signature required but the install was only verified via ${receipt.verifiedVia}`
        : "Signature required but not found"
      return this.createResult(pluginPath, false, reason, warnings)
    }
    warnings.push("Plugin is not signed")
    return this.createResult(pluginPath, true, undefined, warnings)
  }

  /**
   * Read the host-written verification receipt for the plugin at `pluginPath`
   * (keyed by its derived id). Returns `null` off-Tauri (no host) or when no
   * receipt exists / the command fails — the caller treats that as unverified.
   */
  private async readVerificationReceipt(
    pluginPath: string
  ): Promise<PluginVerificationReceipt | null> {
    if (!isTauri()) return null
    try {
      const receipt = await invoke<PluginVerificationReceipt | null>("plugin_read_verification", {
        pluginId: this.extractPluginId(pluginPath),
      })
      return receipt ?? null
    } catch (error) {
      recordSilentFailure(
        "<signature>",
        {
          site: "signature.readVerificationReceipt",
          message: "Could not read host verification receipt.",
          // Unreachable off-Tauri (the early return above bails first) and the
          // `plugin_read_verification` handler is registered, so reaching this
          // catch is always a real failure.
          expected: false,
        },
        error
      )
      return null
    }
  }

  private createResult(
    pluginPath: string,
    valid: boolean,
    reason?: string,
    warnings: string[] = [],
    signatureData?: PluginSignature
  ): SignatureVerificationResult {
    const result: SignatureVerificationResult = {
      valid,
      pluginId: signatureData?.pluginId || this.extractPluginId(pluginPath),
      version: signatureData?.version || "",
      reason,
      warnings,
    }

    if (this.config.cacheVerifications && !valid) {
      this.verificationCache.set(pluginPath, result)
    }

    return result
  }

  private extractPluginId(pluginPath: string): string {
    const parts = pluginPath.split(/[/\\]/)
    return parts[parts.length - 1] || "unknown"
  }

  private findPublisher(publicKey: string): TrustedPublisher | undefined {
    for (const publisher of this.trustedPublishers.values()) {
      if (publisher.publicKey === publicKey) {
        return publisher
      }
    }
    return undefined
  }

  // ===========================================================================
  // Publisher Management
  // ===========================================================================

  async addTrustedPublisher(publisher: Omit<TrustedPublisher, "addedAt">): Promise<void> {
    const fullPublisher: TrustedPublisher = {
      ...publisher,
      addedAt: new Date(),
    }

    this.trustedPublishers.set(publisher.id, fullPublisher)
    this.persistUserPublishersToStorage()
    this.clearCache()
  }

  async removeTrustedPublisher(publisherId: string): Promise<void> {
    this.trustedPublishers.delete(publisherId)
    this.persistUserPublishersToStorage()
    this.clearCache()
  }

  getTrustedPublishers(): TrustedPublisher[] {
    return Array.from(this.trustedPublishers.values())
  }

  getPublisher(publisherId: string): TrustedPublisher | undefined {
    return this.trustedPublishers.get(publisherId)
  }

  isPublisherTrusted(publicKey: string): boolean {
    return this.findPublisher(publicKey) !== undefined
  }

  // ===========================================================================
  // Signing (for plugin developers)
  // ===========================================================================

  async signPlugin(
    pluginPath: string,
    privateKey: string,
    options: {
      algorithm?: "ed25519" | "rsa-sha256"
      expiresIn?: number
    } = {}
  ): Promise<PluginSignature> {
    const signature = await invoke<PluginSignature>("plugin_create_signature", {
      pluginPath,
      privateKey,
      algorithm: options.algorithm || "ed25519",
      expiresIn: options.expiresIn,
    })

    return {
      ...signature,
      signedAt: new Date(signature.signedAt),
      expiresAt: signature.expiresAt ? new Date(signature.expiresAt) : undefined,
    }
  }

  async generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
    return invoke<{ publicKey: string; privateKey: string }>("plugin_generate_keypair")
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  clearCache(pluginPath?: string): void {
    if (pluginPath) {
      this.verificationCache.delete(pluginPath)
    } else {
      this.verificationCache.clear()
    }
  }

  getCachedVerification(pluginPath: string): SignatureVerificationResult | undefined {
    return this.verificationCache.get(pluginPath)
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  setConfig(config: Partial<SignatureConfig>): void {
    this.config = { ...this.config, ...config }
    if (!this.config.cacheVerifications) {
      this.verificationCache.clear()
    }
  }

  getConfig(): SignatureConfig {
    return { ...this.config }
  }

  private readUserPublishersFromStorage(): TrustedPublisher[] {
    try {
      if (typeof localStorage === "undefined") {
        return []
      }
      const raw = localStorage.getItem(USER_PUBLISHERS_STORAGE_KEY)
      if (!raw) {
        return []
      }
      const parsed = JSON.parse(raw) as Array<
        Omit<TrustedPublisher, "addedAt"> & { addedAt: string | Date }
      >
      return parsed.map((publisher) => ({
        ...publisher,
        addedAt: new Date(publisher.addedAt),
      }))
    } catch {
      return []
    }
  }

  private persistUserPublishersToStorage(): void {
    try {
      if (typeof localStorage === "undefined") {
        return
      }
      const officialIds = new Set(OFFICIAL_TRUSTED_PUBLISHERS.map((publisher) => publisher.id))
      const userPublishers = Array.from(this.trustedPublishers.values())
        .filter((publisher) => !officialIds.has(publisher.id))
        .map((publisher) => ({
          ...publisher,
          addedAt: publisher.addedAt.toISOString(),
        }))
      localStorage.setItem(USER_PUBLISHERS_STORAGE_KEY, JSON.stringify(userPublishers))
    } catch (error) {
      recordSilentFailure(
        "<signature>",
        {
          site: "signature.persistUserPublishersToStorage",
          message: "Trusted publisher persistence skipped (storage unavailable).",
          expected: false,
        },
        error
      )
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let signatureVerifierInstance: PluginSignatureVerifier | null = null

export function getPluginSignatureVerifier(
  config?: Partial<SignatureConfig>
): PluginSignatureVerifier {
  if (!signatureVerifierInstance) {
    signatureVerifierInstance = new PluginSignatureVerifier(config)
  }
  return signatureVerifierInstance
}

export function resetPluginSignatureVerifier(): void {
  signatureVerifierInstance = null
}

// =============================================================================
// Detached signature path (WASM plugin bundles)
// =============================================================================

/**
 * Result of an Ed25519 detached-signature verification against a WASM plugin
 * bundle on disk. `valid === true` means the bundle bytes were signed by the
 * holder of `publicKeyBase64`'s private key. Callers still need to check
 * trust separately (is this key in `trustedPublishers`?).
 */
export interface DetachedSignatureCheck {
  valid: boolean
  fingerprint: string
  publicKeyBase64: string
  reason?: string
}

function isTauriRuntimeAvailable(): boolean {
  return isTauri()
}

/**
 * Verify an Ed25519 detached signature (`<bundle>.sig`) against a bundle on
 * disk. Used by the WASM plugin install paths (HTTP / Git). Returns the
 * SHA-256 fingerprint of the public key in lowercase hex so the install UI
 * can render an identity chip before the user accepts.
 *
 * Browser-mode (non-Tauri) returns `valid: false, reason: "host-unavailable"`
 * so callers can degrade rather than throw.
 */
export async function verifyDetachedBundleSignature(args: {
  artifactPath: string
  signatureBase64: string
  publicKeyBase64: string
}): Promise<DetachedSignatureCheck> {
  if (!isTauriRuntimeAvailable()) {
    return {
      valid: false,
      fingerprint: "",
      publicKeyBase64: args.publicKeyBase64,
      reason: "host-unavailable",
    }
  }
  try {
    const [valid, fingerprint] = await Promise.all([
      invoke<boolean>("plugin_verify_detached_signature", {
        artifactPath: args.artifactPath,
        signatureBase64: args.signatureBase64,
        publicKeyBase64: args.publicKeyBase64,
      }),
      invoke<string>("plugin_public_key_fingerprint", {
        publicKeyBase64: args.publicKeyBase64,
      }),
    ])
    return { valid, fingerprint, publicKeyBase64: args.publicKeyBase64 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordSilentFailure(
      "",
      {
        site: "plugin.security.verifyDetachedBundleSignature",
        message,
        expected: !isTauriRuntimeAvailable(),
      },
      error
    )
    return {
      valid: false,
      fingerprint: "",
      publicKeyBase64: args.publicKeyBase64,
      reason: message,
    }
  }
}

/**
 * Human-friendly fingerprint slice for the install dialog: shows
 * `ed25519:9f:3a:...` (the first 8 hex pairs of the sha256).
 */
export function shortFingerprint(fingerprint: string): string {
  if (!fingerprint) return ""
  const pairs = fingerprint.match(/.{2}/g)?.slice(0, 8) ?? []
  return `ed25519:${pairs.join(":")}`
}
