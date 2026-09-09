/**
 * Local-file WASM plugin installer.
 *
 * The third source `crates/cognia-plugin-runtime/src/wasm/installer.rs` has
 * always documented, alongside the HTTP and Git ones this module mirrors. It
 * had no backend until now, so `installWasmPluginFromLocalFile` reached for
 * `plugin_install` instead, a command that unpacks nothing (it validates a
 * manifest, creates a directory and writes `manifest.json`) and whose signature
 * the call did not match either. The "Install from file" button therefore could
 * not succeed under any input.
 *
 * Everything after "have the bytes" is the same host path the URL installer
 * takes: the same archive limits, the same manifest-contract validation, and
 * the same atomic replace over a prior install.
 *
 * `.zip` only. A bare `.wasm` carries no manifest, so there is no id to install
 * under, nothing to validate and no capabilities to grant.
 *
 * Desktop-only, and more narrowly so than its siblings: they name a URL or a
 * repository, while this names a path on the host, so the command is
 * deliberately absent from the companion manifest.
 */

import type { PluginManifest } from "@/types/plugin"
import { loggers } from "@/lib/plugin/core/logger"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { trustPublisher, type TrustPublisherInput } from "@/lib/db/trusted-publishers"

const installerLogger = loggers.manager.child
  ? loggers.manager.child("wasm-installer")
  : loggers.manager

export interface LocalInstallArgs {
  /** Absolute path to the `.zip` bundle on this machine. */
  bundlePath: string
  /**
   * Detached Ed25519 signature, base64. Unlike the HTTP installer there is no
   * second URL to fetch, so the caller hands the signature over directly.
   */
  signatureBase64?: string
  /** Public key (base64) expected to have signed the bundle. */
  expectedPublicKeyBase64?: string
}

export interface LocalInstallResult {
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
 * Install a WASM plugin from a `.zip` on this machine.
 *
 * Records the publisher in the trust ledger on success, exactly as
 * `installFromUrl` does, so a later update of the same plugin skips the
 * fingerprint dialog. A failure to record is logged and swallowed: the plugin
 * is already installed, and losing the trust note is not worth turning a
 * finished install into an error.
 */
export async function installFromLocalFile(args: LocalInstallArgs): Promise<LocalInstallResult> {
  if (!canUseTauriInvoke()) {
    throw new Error("Installing a plugin from a local file requires the Tauri desktop runtime.")
  }
  // Both or neither. The host enforces this too, but refusing here names the
  // argument the caller got wrong instead of surfacing it as an install error.
  if (Boolean(args.signatureBase64) !== Boolean(args.expectedPublicKeyBase64)) {
    throw new Error("signatureBase64 and expectedPublicKeyBase64 must be provided together.")
  }

  const invoke = await getInvoke()
  const result = await invoke<RustInstallResult>("plugin_wasm_install_from_file", {
    bundlePath: args.bundlePath,
    signatureBase64: args.signatureBase64 ?? null,
    expectedPublicKeyBase64: args.expectedPublicKeyBase64 ?? null,
  })

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

  return {
    manifest: result.manifest,
    path: result.path,
    signatureVerified: result.signatureVerified,
    authorPublicKey: result.authorPublicKey,
    authorFingerprint: result.authorFingerprint,
  }
}
