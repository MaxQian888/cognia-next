/**
 * Export a cogset as a cogpack (ADR-0209).
 *
 * Two steps, because the user reviews what leaves the machine before it does:
 *
 * 1. `previewCogsetExport` decides, per member, whether it travels as a
 *    reference (its recorded origin can be fetched again at exactly the
 *    installed version) or embedded (its files go in the cogpack), and which
 *    non-secret config it carries. Secret fields never travel; their names do,
 *    so the importer knows what to fill in.
 * 2. `exportCogsetPreview` builds and signs the file from the reviewed preview,
 *    minus any config the user chose to leave out.
 *
 * Always-on plugins are this host's choice, not the cogset's, and are never
 * exported.
 */

import { APP_VERSION } from "@/lib/app-version"
import { getCogset, getCogsetState } from "@/lib/db/plugin-cogsets"
import { getInstallOrigin } from "@/lib/db/plugin-install-origins"
import { getPlugin } from "@/lib/db/plugins"
import type { PluginInstallOriginRecord } from "@/types/plugin/plugin-cogset"
import type { PluginRow } from "@/lib/db/plugin-types"
import { listSecretConfigFields, stripSecretConfig } from "@/lib/plugin/core/config-secrets"
import { isReproducibleOrigin, resolvePluginOrigin } from "@/lib/plugin/origin/install-origin"
import type { CogsetRow, ReproducibleInstallOrigin } from "@/types/plugin/plugin-cogset"

import {
  exportCogpack,
  type CogpackExportMember,
  type CogpackSigner,
  type EmbeddedPluginFile,
  type ExportedCogpack,
} from "./package"

/** Why a member cannot travel in a cogpack at all. */
export type CogpackUnportableReason = "vscode-local"

export interface CogpackExportPreviewMember {
  pluginId: string
  name: string
  version: string
  optional: boolean
  /** Referenced by its origin, or embedded. */
  source: ReproducibleInstallOrigin | { kind: "embedded" }
  /** Non-secret config the member carries. */
  config?: Record<string, unknown>
  secretFields: string[]
  /** Shown for embedded members: their licence travels with their files. */
  licenseText?: string
}

export interface CogpackExportPreview {
  cogset: CogsetRow
  members: CogpackExportPreviewMember[]
  /** Members that are not installed here, so there is nothing to export. */
  missing: string[]
  /** Members that are installed but cannot be carried. */
  unportable: Array<{ pluginId: string; name: string; reason: CogpackUnportableReason }>
  /** Always-on plugins, which stay with this host. */
  alwaysOnExcluded: string[]
}

export interface CogpackExportDeps {
  getCogset: typeof getCogset
  getCogsetState: typeof getCogsetState
  getPlugin: (id: string) => Promise<PluginRow | undefined>
  getInstallOrigin: (id: string) => Promise<PluginInstallOriginRecord | undefined>
  readTree: (pluginId: string) => Promise<EmbeddedPluginFile[]>
  appVersion: string
}

async function defaultDeps(): Promise<CogpackExportDeps> {
  const { readInstalledPluginTree } = await import("./plugin-tree")
  return {
    getCogset,
    getCogsetState,
    getPlugin,
    getInstallOrigin,
    readTree: readInstalledPluginTree,
    appVersion: APP_VERSION,
  }
}

export async function previewCogsetExport(
  cogsetId: string,
  deps?: CogpackExportDeps
): Promise<CogpackExportPreview> {
  const d = deps ?? (await defaultDeps())
  const cogset = await d.getCogset(cogsetId)
  if (!cogset) throw new Error(`Cogset ${cogsetId} does not exist`)
  const alwaysOn = new Set((await d.getCogsetState()).alwaysOn)
  const preview: CogpackExportPreview = {
    cogset,
    members: [],
    missing: [],
    unportable: [],
    alwaysOnExcluded: [],
  }
  for (const member of cogset.members) {
    if (alwaysOn.has(member.pluginId)) {
      preview.alwaysOnExcluded.push(member.pluginId)
      continue
    }
    const row = await d.getPlugin(member.pluginId)
    if (!row) {
      preview.missing.push(member.pluginId)
      continue
    }
    const record = await d.getInstallOrigin(member.pluginId)
    const origin = resolvePluginOrigin(row, record)
    // An origin recorded for another version describes a different install;
    // only the exact installed version can be promised to the importer.
    const reproducible =
      isReproducibleOrigin(origin) && (origin.kind === "builtin" || record?.version === row.version)
    if (!reproducible && row.type === "vscode-extension") {
      preview.unportable.push({ pluginId: row.id, name: row.name, reason: "vscode-local" })
      continue
    }
    const secretFields = listSecretConfigFields(row.manifest)
    const config = member.config
      ? stripSecretConfig(member.config, row.manifest)
      : stripSecretConfig(row.config, row.manifest)
    preview.members.push({
      pluginId: row.id,
      name: row.name,
      version: row.version,
      optional: !!member.optional,
      source: reproducible ? (origin as ReproducibleInstallOrigin) : { kind: "embedded" },
      ...(Object.keys(config).length > 0 ? { config } : {}),
      secretFields,
      ...(!reproducible && row.licenseText ? { licenseText: row.licenseText } : {}),
    })
  }
  return preview
}

export interface ExportCogsetPreviewInput {
  preview: CogpackExportPreview
  id: string
  version: string
  name: string
  description?: string
  /** Members whose config the user chose to leave out of the file. */
  withoutConfig?: ReadonlySet<string>
  signer?: CogpackSigner
}

export async function exportCogsetPreview(
  input: ExportCogsetPreviewInput,
  deps?: CogpackExportDeps
): Promise<ExportedCogpack> {
  const d = deps ?? (await defaultDeps())
  const members: CogpackExportMember[] = input.preview.members.map((member) => ({
    id: member.pluginId,
    name: member.name,
    version: member.version,
    optional: member.optional,
    source: member.source,
    ...(member.config && !input.withoutConfig?.has(member.pluginId)
      ? { config: member.config }
      : {}),
    ...(member.secretFields.length > 0 ? { secretFields: member.secretFields } : {}),
  }))
  const embedded = new Map<string, EmbeddedPluginFile[]>()
  for (const member of input.preview.members) {
    if (member.source.kind === "embedded") {
      embedded.set(member.pluginId, await d.readTree(member.pluginId))
    }
  }
  return exportCogpack({
    id: input.id,
    version: input.version,
    name: input.name,
    description: input.description,
    minHostVersion: d.appVersion,
    members,
    embedded,
    signer: input.signer,
  })
}

/** A cogpack id derived from a cogset name: lowercase, dash-separated. */
export function suggestCogpackId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return slug || "cogpack"
}
