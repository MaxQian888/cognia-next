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
import { canUseTauriInvoke } from "@/lib/native/utils"
import { recordInstalledPublisher, validateInstalledPublisher } from "./http-installer"

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
  /** Pin confirmation to the exact bytes inspected during preview. */
  expectedBundleSha256?: string
  /** Stage for PluginManager without replacing an existing package. */
  deferCommit?: boolean
}

export interface LocalInstallResult {
  manifest: PluginManifest
  /** Directory on disk where the bundle was unpacked. */
  path: string
  /** Whether the Ed25519 signature was verified end-to-end. */
  signatureVerified: boolean
  bundleSha256: string
  transactionId?: string
  authorPublicKey?: string
  authorFingerprint?: string
}

interface RustInstallResult {
  manifest: PluginManifest
  path: string
  source: string
  installRootKind: string
  signatureVerified: boolean
  bundleSha256: string
  transactionId?: string
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
export async function previewLocalBundleManifest(
  args: LocalInstallArgs
): Promise<LocalInstallResult> {
  return installFromLocalFileInternal(args, true)
}

export async function installFromLocalFile(args: LocalInstallArgs): Promise<LocalInstallResult> {
  return installFromLocalFileInternal(args, false)
}

async function installFromLocalFileInternal(
  args: LocalInstallArgs,
  previewOnly: boolean
): Promise<LocalInstallResult> {
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
    previewOnly,
    deferCommit: args.deferCommit ?? false,
    expectedBundleSha256: args.expectedBundleSha256 ?? null,
  })

  await validateInstalledPublisher(
    result,
    args.expectedPublicKeyBase64,
    Boolean(args.signatureBase64),
    invoke
  )

  if (!previewOnly && !args.deferCommit) await recordInstalledPublisher(result)

  return {
    manifest: result.manifest,
    path: result.path,
    signatureVerified: result.signatureVerified,
    bundleSha256: result.bundleSha256,
    transactionId: result.transactionId ?? undefined,
    authorPublicKey: result.authorPublicKey,
    authorFingerprint: result.authorFingerprint,
  }
}
