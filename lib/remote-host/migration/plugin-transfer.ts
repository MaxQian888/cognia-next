/**
 * Carry the plugins an item needs to a paired host (ADR-0224 §Moving an item
 * is a handoff, step 2; ADR-0209 cogpacks).
 *
 * Preflight lists what the host lacks (`plugin-missing`,
 * `plugin-version-mismatch`). Once the user confirms, this exports exactly
 * those plugins, at the versions installed here, as one cogpack signed with
 * this device's publisher identity, uploads it over the management channel in
 * chunks the device plane accepts, and asks the host to install it. The host
 * decides: it verifies the signature and applies its OWN plugin policy and
 * trusted publishers, so a host that only accepts trusted publishers refuses a
 * device it has not been told to trust, and the user sees why.
 *
 * Only plugins this desktop has on disk can travel: the files are read by the
 * Rust host here (`plugin_export_tree`).
 */

import { APP_VERSION } from "@/lib/app-version"
import { sha256Bytes } from "@/lib/ocr/hash"
import { encodeBase64 } from "@/lib/share/encoding"
import type { CogpackSigner, EmbeddedPluginFile } from "@/lib/plugin/cogpack/package"
import type { TransferInstallResult } from "@/lib/plugin/cogpack/transfer-install"
import {
  withManagementChannel,
  type ManagementChannelDeps,
} from "@/lib/remote-host/management-channel"
import type { Transport } from "@/lib/tauri/transport-types"

import type { MigrationPreflight } from "./types"

export interface PluginTransferRequest {
  pluginId: string
  version: string
}

export interface PluginTransferProgress {
  sentBytes: number
  totalBytes: number
  phase: "packing" | "uploading" | "installing"
}

export interface PluginTransferDeps {
  channel?: ManagementChannelDeps
  readTree?: (pluginId: string) => Promise<EmbeddedPluginFile[]>
  localPlugin?: (pluginId: string) => Promise<{ name: string; version: string } | undefined>
  signer?: () => Promise<CogpackSigner>
  newOperationId?: () => string
  sourceLabel?: () => string
}

/** Thrown when the plugin here is no longer the version preflight saw. */
export class PluginChangedHereError extends Error {
  constructor(readonly pluginId: string) {
    super(`plugin_changed_here: ${pluginId} is not at the version preflight checked`)
    this.name = "PluginChangedHereError"
  }
}

/**
 * The plugins a batch's preflights ask the host for, once each, at the
 * version installed here. Only what transfer can clear is listed.
 */
export function pluginsToTransfer(
  preflights: readonly MigrationPreflight[]
): PluginTransferRequest[] {
  const wanted = new Map<string, string>()
  for (const preflight of preflights) {
    for (const blocker of preflight.blockers) {
      if (blocker.kind === "plugin-missing" || blocker.kind === "plugin-version-mismatch") {
        wanted.set(blocker.pluginId, blocker.version)
      }
    }
  }
  return [...wanted]
    .map(([pluginId, version]) => ({ pluginId, version }))
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

async function defaultReadTree(pluginId: string): Promise<EmbeddedPluginFile[]> {
  const { readInstalledPluginTree } = await import("@/lib/plugin/cogpack/plugin-tree")
  return readInstalledPluginTree(pluginId)
}

async function defaultLocalPlugin(
  pluginId: string
): Promise<{ name: string; version: string } | undefined> {
  const { getPlugin } = await import("@/lib/db/plugins")
  const row = await getPlugin(pluginId)
  if (!row) return undefined
  const name =
    typeof row.manifest.name === "string" && row.manifest.name ? row.manifest.name : row.id
  return { name, version: row.version }
}

async function defaultSigner(): Promise<CogpackSigner> {
  const { createPublisherSigner } = await import("@/lib/templates/publisher-identity")
  return createPublisherSigner()
}

async function defaultSourceLabel(): Promise<string> {
  const { suggestDeviceName } = await import("@/lib/account-sync/enrollment/platform")
  return suggestDeviceName() || "desktop"
}

/** Upload `bytes` in the host's chunk size; the upload is aborted if any chunk fails. */
async function upload(
  transport: Transport,
  bytes: Uint8Array,
  adminLease: string,
  onProgress?: (progress: PluginTransferProgress) => void
): Promise<string> {
  const opened = await transport.call<{ uploadId: string; chunkBytes: number }>(
    "plugin_cogpack_upload_open",
    { byteLength: bytes.byteLength, sha256: await sha256Bytes(bytes), adminLease }
  )
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, offset + opened.chunkBytes)
      await transport.call("plugin_cogpack_upload_write", {
        uploadId: opened.uploadId,
        offset,
        dataBase64: encodeBase64(chunk),
        chunkHash: await sha256Bytes(chunk),
        adminLease,
      })
      offset += chunk.byteLength
      onProgress?.({ sentBytes: offset, totalBytes: bytes.byteLength, phase: "uploading" })
    }
    return opened.uploadId
  } catch (error) {
    await transport
      .call("plugin_cogpack_upload_abort", { uploadId: opened.uploadId, adminLease })
      .catch(() => undefined)
    throw error
  }
}

/**
 * Pack, upload and install `plugins` on the host. Resolves to what the host
 * installed and what it could not; refusals by the host's policy reject with
 * the host's `cogpack_*` message.
 */
export async function transferPlugins(
  hostId: string,
  plugins: readonly PluginTransferRequest[],
  options: { adminLease: string; onProgress?: (progress: PluginTransferProgress) => void },
  deps: PluginTransferDeps = {}
): Promise<TransferInstallResult> {
  if (plugins.length === 0) return { fingerprint: "", installed: [], failed: [] }
  const readTree = deps.readTree ?? defaultReadTree
  const localPlugin = deps.localPlugin ?? defaultLocalPlugin
  const operationId = (deps.newOperationId ?? (() => crypto.randomUUID()))()
  const sourceLabel = deps.sourceLabel?.() || (await defaultSourceLabel())

  options.onProgress?.({ sentBytes: 0, totalBytes: 0, phase: "packing" })
  const members = []
  const embedded = new Map<string, EmbeddedPluginFile[]>()
  for (const plugin of plugins) {
    const here = await localPlugin(plugin.pluginId)
    if (!here || here.version !== plugin.version) throw new PluginChangedHereError(plugin.pluginId)
    members.push({
      id: plugin.pluginId,
      name: here.name,
      version: plugin.version,
      optional: false,
      source: { kind: "embedded" as const },
    })
    embedded.set(plugin.pluginId, await readTree(plugin.pluginId))
  }
  const { exportCogpack } = await import("@/lib/plugin/cogpack/package")
  const exported = await exportCogpack({
    id: `transfer-${operationId}`,
    version: "1.0.0",
    name: `Plugins from ${sourceLabel}`.slice(0, 100),
    minHostVersion: APP_VERSION,
    members,
    embedded,
    signer: await (deps.signer ?? defaultSigner)(),
  })

  return withManagementChannel(
    hostId,
    async ({ transport }) => {
      const uploadId = await upload(
        transport,
        exported.bytes,
        options.adminLease,
        options.onProgress
      )
      options.onProgress?.({
        sentBytes: exported.bytes.byteLength,
        totalBytes: exported.bytes.byteLength,
        phase: "installing",
      })
      return transport.call<TransferInstallResult>("plugin_cogpack_transfer_install", {
        uploadId,
        operationId,
        manifest: exported.manifest,
        sourceLabel,
        adminLease: options.adminLease,
      })
    },
    deps.channel
  )
}
