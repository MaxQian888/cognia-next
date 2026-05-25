"use client"

// Live-query view-model for built-in plugins, projected into the marketplace
// entry shape so the Discover surface can list them in a dedicated "Built-in"
// section. Built-in plugins are discovered at startup
// (PluginManager.scanPlugins → discoverPlugin(source="builtin")) and persisted
// to Dexie; this hook reads them back independently of the remote registry,
// which is why the section stays populated even when the marketplace backend
// is unreachable.

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listPluginsBySource } from "@/lib/db/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginPermission } from "@/types/plugin"
import type { SignatureState } from "@/components/plugins/plugin-signature-badge"
import type { PluginMarketplaceEntry } from "./use-plugin-marketplace"

/**
 * Marketplace entry enriched with the fields the card / detail render for a
 * built-in plugin. Mirrors the optional shape the card already accepts
 * (`capabilities` / `permissions` / `signatureState`) and pins `source` so the
 * UI can gate install/uninstall off.
 */
export type BuiltinMarketplaceEntry = PluginMarketplaceEntry & {
  capabilities: string[]
  permissions: PluginPermission[]
  signatureState: SignatureState
}

/** Mirror of plugin-library-row.tsx's manifest-signature derivation. */
function signatureStateOf(manifest: Record<string, unknown>): SignatureState {
  const sig = (manifest as { signature?: { verified?: boolean; failed?: boolean } })?.signature
  if (sig?.verified) return "verified"
  if (sig?.failed) return "failed"
  return "unverified"
}

/** Manifest author may be a bare string or an object with a `name`. */
function authorOf(manifest: Record<string, unknown>): string | undefined {
  const author = (manifest as { author?: unknown }).author
  if (typeof author === "string") return author
  if (author && typeof author === "object" && "name" in author) {
    const name = (author as { name?: unknown }).name
    return typeof name === "string" ? name : undefined
  }
  return undefined
}

export function mapBuiltinRowToEntry(row: PluginRow): BuiltinMarketplaceEntry {
  const manifest = row.manifest ?? {}
  const permissions = Array.isArray((manifest as { permissions?: unknown }).permissions)
    ? ((manifest as { permissions: unknown[] }).permissions as PluginPermission[])
    : []
  const description = (manifest as { description?: unknown }).description
  const signatureState = signatureStateOf(manifest)
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: typeof description === "string" ? description : undefined,
    author: authorOf(manifest),
    signed: signatureState === "verified",
    type: "plugin",
    source: "builtin",
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    permissions,
    signatureState,
  }
}

/**
 * Reactive list of built-in plugins, mapped to marketplace entries. Returns an
 * empty array while the live query is still resolving.
 */
export function useBuiltinPluginEntries(): BuiltinMarketplaceEntry[] {
  const rows = useLiveQuery(() => listPluginsBySource("builtin"), [])
  return useMemo(() => (rows ?? []).map(mapBuiltinRowToEntry), [rows])
}
