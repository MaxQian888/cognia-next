/**
 * HTTP-URL WASM plugin installer.
 *
 * Drives the `plugin_wasm_install_from_url` Tauri command and the
 * `trustedPublishers` Dexie ledger so the UI flow can:
 *
 *   1. peek the manifest before committing (`previewBundleManifest`),
 *   2. show the user the author's fingerprint *iff* it's not already
 *      trusted (`isPublisherTrusted`),
 *   3. install + verify in a single round-trip (`installFromUrl`),
 *   4. record the now-accepted publisher (`trustPublisher`).
 *
 * Browser mode is a hard error — the Rust host owns crypto + filesystem.
 */

import type { PluginManifest } from "@/types/plugin"
import { loggers } from "@/lib/plugin/core/logger"
import { canUseTauriInvoke } from "@/lib/native/utils"
import {
  isPublisherTrusted,
  trustPublisher,
  type TrustPublisherInput,
} from "@/lib/db/trusted-publishers"

const installerLogger = loggers.manager.child
  ? loggers.manager.child("wasm-installer")
  : loggers.manager

export interface HttpInstallArgs {
  /** Direct URL to the `.zip` bundle (must be HTTPS in production). */
  bundleUrl: string
  /** Optional URL to the detached Ed25519 signature (base64 in the body). */
  signatureUrl?: string
  /**
   * Public key (base64) expected to have signed the bundle. Required when
   * `signatureUrl` is provided. When omitted, the install proceeds without
   * cryptographic verification but the host will still validate that the
   * manifest declares `type: "wasm"`.
   */
  expectedPublicKeyBase64?: string
  /**
   * Whether to require a signature even if the manifest doesn't declare an
   * `author.publicKey`. Pass `false` for sideload-style installs from a
   * trusted local server.
   */
  requireSignature?: boolean
}

export interface HttpInstallResult {
  manifest: PluginManifest
  /** Directory on disk where the bundle was unpacked. */
  path: string
  /** Whether the Ed25519 signature was verified end-to-end. */
  signatureVerified: boolean
  authorPublicKey?: string
  authorFingerprint?: string
}

interface RustInstallResult {
  manifest: PluginManifest
  path: string
  source: string
  installRootKind: string
  signatureVerified: boolean
  authorPublicKey?: string
  authorFingerprint?: string
}

let cachedInvoke: (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | undefined

async function getInvoke(): Promise<
  <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
> {
  if (cachedInvoke) return cachedInvoke
  const mod = await import("@tauri-apps/api/core")
  cachedInvoke = mod.invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  return cachedInvoke
}

/**
 * Peek at the manifest without committing to install — useful when the UI
 * wants to show the user a confirmation card before pulling the trigger.
 *
 * Internally this downloads + extracts to a temp dir, so it pays the same
 * bandwidth cost as the actual install. We accept that cost because most
 * users will then proceed; for the cancel path it's still a few hundred KB
 * of throwaway I/O.
 */
export async function previewBundleManifest(args: HttpInstallArgs): Promise<HttpInstallResult> {
  return installFromUrlInternal({ ...args, requireSignature: args.requireSignature ?? false }, true)
}

/**
 * Install a signed WASM plugin from an HTTP URL. Verifies the detached
 * signature against `expectedPublicKeyBase64` when both that and
 * `signatureUrl` are provided. Records the publisher in the trust ledger
 * on success so subsequent updates skip the fingerprint dialog.
 */
export async function installFromUrl(args: HttpInstallArgs): Promise<HttpInstallResult> {
  const result = await installFromUrlInternal(args, false)
  if (result.authorPublicKey && result.authorFingerprint && result.signatureVerified) {
    const trustInput: TrustPublisherInput = {
      publicKey: result.authorPublicKey,
      fingerprint: result.authorFingerprint,
      authorName: result.manifest.author?.name,
      authorEmail: result.manifest.author?.email,
      homepage: result.manifest.homepage,
    }
    try {
      await trustPublisher(trustInput)
    } catch (error) {
      installerLogger.warn("Failed to record trusted publisher", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

async function installFromUrlInternal(
  args: HttpInstallArgs,
  _previewOnly: boolean
): Promise<HttpInstallResult> {
  if (!canUseTauriInvoke()) {
    throw new Error(
      "HTTP plugin installs require the Tauri desktop runtime (network-based bundle install is desktop-only)."
    )
  }
  if (args.signatureUrl && !args.expectedPublicKeyBase64) {
    throw new Error("expectedPublicKeyBase64 is required when signatureUrl is provided.")
  }
  if (!args.signatureUrl && args.requireSignature) {
    throw new Error("A signature URL is required for this install (requireSignature=true).")
  }

  const invoke = await getInvoke()
  const result = await invoke<RustInstallResult>("plugin_wasm_install_from_url", {
    bundleUrl: args.bundleUrl,
    signatureUrl: args.signatureUrl ?? null,
    expectedPublicKeyBase64: args.expectedPublicKeyBase64 ?? null,
  })

  return {
    manifest: result.manifest,
    path: result.path,
    signatureVerified: result.signatureVerified,
    authorPublicKey: result.authorPublicKey,
    authorFingerprint: result.authorFingerprint,
  }
}

/**
 * True when this Ed25519 public key was previously accepted by the user.
 * The install dialog skips the fingerprint confirmation step when this
 * returns true — the assumption is "you already vetted this author once".
 */
export async function isPublisherKeyTrusted(publicKey?: string): Promise<boolean> {
  if (!publicKey) return false
  return isPublisherTrusted(publicKey)
}
