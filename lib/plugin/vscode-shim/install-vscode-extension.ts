/**
 * The single place a `.vsix` becomes an installed cognia plugin.
 *
 * Both entry points — the drag-drop dialog and the Open VSX marketplace —
 * funnel through here so the manifest adaptation cannot be skipped again.
 *
 * ## Why this module exists
 *
 * The install dialog used to persist the raw VS Code `package.json` as the
 * cognia manifest. That broke two ways at once:
 *
 * 1. **Legitimate extensions never activated.** `loadVscodeDefinition` requires
 *    `manifest.vscodeMain` and `manifest.vscodeExtension.identifier`; only
 *    `adaptVscodeManifest` produces them. A real `package.json` has `main`, no
 *    `vscodeExtension` block, and therefore always threw at activate time —
 *    the error text even said "manifest adapter must populate this at install".
 *
 * 2. **Hostile extensions activated _and_ escalated.** Because the raw object
 *    was persisted verbatim, a crafted `package.json` could self-declare
 *    `vscodeExtension.publisherKeyFingerprint`. `manager.ts` forwards that
 *    field to `lsp-binary-policy`, which matched it against the
 *    `trustedPublishers` ledger by plain string equality and then granted
 *    prompt-free `child_process.spawn`.
 *
 * `adaptVscodeManifest` rebuilds the `vscodeExtension` block from scratch and
 * never copies a fingerprint out of the source manifest, so routing every
 * install through it closes both holes with one change.
 *
 * ## Two phases, on purpose
 *
 * `prepare` does no I/O beyond parsing; `commit` touches disk and Dexie. The
 * split lets callers show real, inferred permissions *before* the user
 * consents — the dialog previously read `pkgJson.permissions`, a field VS Code
 * manifests do not have, so its permission review was always empty.
 */

import { loggers } from "@cognia/logging"
import { upsertPlugin } from "@/lib/db/plugins"
import { canUseTauriInvoke } from "@/lib/native/utils"
// `PluginRow` lives in `plugin-types`; `schema.ts` imports it for its table
// declarations but does not re-export it.
import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginSource } from "@/types/plugin/plugin"
import type {
  VsCodeExtensionAdapterResult,
  VsCodeExtensionBlock,
} from "@/types/plugin/plugin-vscode"
import { adaptVscodeManifest } from "./manifest-adapter"
import { inferPermissions } from "./permission-inference"
import { installVsix, type VsixInstallResult } from "./vsix-installer"

/** A parsed + adapted `.vsix`, ready to review and then commit. */
export interface PreparedVscodeExtension {
  /** Raw `.vsix` bytes, retained for the commit step. */
  bytes: Uint8Array
  /** Parsed archive — themes, files, sha256, LSP binary candidates. */
  vsix: VsixInstallResult
  /** The cognia manifest plus inference, warnings, and binary candidates. */
  adapted: VsCodeExtensionAdapterResult
  /**
   * Path to a `.vsix` the Rust downloader already staged and checksum-verified
   * (`plugin_vscode_download_vsix`). Present only on the Open VSX path.
   *
   * When set, the commit installs from that path instead of shipping the bytes
   * back over IPC as base64. On an 80 MB extension the base64 round trip means
   * a ~107 MB JS string alongside the Rust `Vec` — the difference between
   * installing and OOMing the webview. The bytes still had to reach JS (that is
   * where permission inference runs); this only avoids re-encoding them to hand
   * back something Rust already has on disk.
   *
   * Rust consumes the file: it is deleted whether the install succeeds or not.
   */
  stagedPath?: string
}

/** Shape returned by the Rust `plugin_vscode_install_vsix` command. */
interface RustInstallResult {
  extensionId: string
  installPath: string
  sha256Hex: string
  packageJson: unknown
}

/**
 * Parse a `.vsix` and derive its cognia manifest. No disk or Dexie writes.
 *
 * @throws when the archive is malformed, over the size cap, or its
 * `publisher` / `name` cannot form a safe id (see `./extension-id`).
 */
export async function prepareVscodeExtension(
  bytes: Uint8Array,
  source: VsCodeExtensionBlock["source"],
  /**
   * The Open VSX `targetPlatform` this build was resolved for. Only the
   * marketplace path knows it (the platform is a registry fact, not something
   * the archive declares); drag-drop leaves it undefined.
   */
  targetPlatform?: string
): Promise<PreparedVscodeExtension> {
  const vsix = await installVsix(bytes)
  const inference = inferPermissions({ vsix })
  const adapted = adaptVscodeManifest({ vsix, inference, source, targetPlatform })
  return { bytes, vsix, adapted }
}

/**
 * Unpack a prepared extension to disk (Tauri only) and record it in Dexie.
 *
 * Browser mode skips the native unpack and records a `vsix://` placeholder
 * path, matching how the loader already degrades outside Tauri.
 */
export async function commitVscodeExtension(prepared: PreparedVscodeExtension): Promise<PluginRow> {
  const { bytes, vsix, adapted, stagedPath } = prepared
  let installPath: string | null = null

  if (canUseTauriInvoke()) {
    const { invoke } = await import("@tauri-apps/api/core")
    // Two commands, one installer behind them. `..._from_path` is used when the
    // downloader already put a verified copy on disk; the base64 form is for
    // bytes that only ever existed in the renderer (drag-drop).
    const result = stagedPath
      ? await invoke<RustInstallResult>("plugin_vscode_install_vsix_from_path", {
          tempPath: stagedPath,
        })
      : await invoke<RustInstallResult>("plugin_vscode_install_vsix", {
          vsixBase64: bytesToBase64(bytes),
        })
    installPath = result.installPath

    // Rust derives the id under the same strict rule (`sanitize_plugin_id_strict`)
    // before it touches the filesystem. If the two ever disagree, the Dexie row
    // and the on-disk directory would describe different extensions — surface
    // that as a hard failure rather than persisting a mismatched row.
    if (result.extensionId !== adapted.manifest.id) {
      throw new Error(
        `VS Code extension id mismatch: renderer derived "${adapted.manifest.id}", ` +
          `Rust unpacked to "${result.extensionId}". The id rules have drifted — ` +
          `lib/plugin/vscode-shim/extension-id.ts and sanitize_plugin_id_strict must agree.`
      )
    }
  }

  return upsertPlugin({
    id: adapted.manifest.id,
    name: adapted.manifest.name,
    version: adapted.manifest.version,
    status: "discovered",
    source: pluginRowSource(adapted.manifest.vscodeExtension?.source ?? null),
    type: "vscode-extension",
    path: installPath ?? `vsix://${adapted.manifest.id}@${vsix.sha256.slice(0, 12)}`,
    // The whole point of this module: the *adapted* manifest, never `pkgJson`.
    manifest: adapted.manifest as unknown as Record<string, unknown>,
    enabled: false,
    capabilities: adapted.manifest.capabilities,
  })
}

/** Parse, adapt, unpack, and record in one call. */
export async function installVscodeExtensionFromBytes(input: {
  bytes: Uint8Array
  source: VsCodeExtensionBlock["source"]
}): Promise<{ row: PluginRow; prepared: PreparedVscodeExtension }> {
  const prepared = await prepareVscodeExtension(input.bytes, input.source)
  if (prepared.adapted.warnings.length > 0) {
    loggers.plugin.warn("VS Code manifest adapted with warnings", {
      extension: prepared.adapted.manifest.id,
      warnings: prepared.adapted.warnings,
    })
  }
  const row = await commitVscodeExtension(prepared)
  return { row, prepared }
}

/**
 * Map the manifest-level install source onto `PluginRow.source`.
 *
 * These are two different vocabularies that happen to share a field name.
 * `VsCodeExtensionBlock["source"]` records *how the extension reached us*
 * (`"openvsx" | "vsix-upload" | "dev" | null`), while `PluginSource` is the
 * generic plugin origin (`"builtin" | "local" | "marketplace" | "git" | "dev"`)
 * and has no `"openvsx"` member. Conflating them is a type error at best and a
 * mislabelled row at worst.
 */
function pluginRowSource(source: VsCodeExtensionBlock["source"]): PluginSource {
  switch (source) {
    case "openvsx":
      return "marketplace"
    case "dev":
      return "dev"
    default:
      return "local"
  }
}

/**
 * Encode bytes as base64 for the Tauri IPC boundary.
 *
 * Chunked because `String.fromCharCode(...bytes)` blows the argument limit on
 * anything but a toy extension. The `Buffer` fallback keeps this usable under
 * the Jest node environment, where `btoa` is not guaranteed.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 32 * 1024
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[])
  }
  return typeof btoa !== "undefined"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64")
}
