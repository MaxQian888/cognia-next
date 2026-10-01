"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useLocale, useTranslations } from "next-intl"

import type { PluginRow } from "@/lib/db/plugin-types"
import { getDb } from "@/lib/db/schema"
import { localizedPluginName } from "@/lib/plugin/i18n/manifest-text"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"
import { DEFAULT_COGSET_NAME } from "@/lib/plugin/cogset/bootstrap-default"
import { useCogsetSessionStore } from "@/stores/plugins/cogset-session-store"
import { useProjectStore } from "@/stores/project/project-store"
import {
  COGSET_STATE_ID,
  type CogsetRow,
  type CogsetStateRow,
  type EffectiveCogsetSource,
} from "@/types/plugin/plugin-cogset"

export interface CogsetsView {
  cogsets: CogsetRow[]
  state: CogsetStateRow | undefined
  /** The cogset whose reconciliation last ran on the host. */
  applied: CogsetRow | undefined
  /** The cogset that should be running, and why. */
  effective: { cogset: CogsetRow; source: EffectiveCogsetSource } | null
  /** The active workspace's binding, if it has one. */
  workspaceCogset: CogsetRow | undefined
  activeWorkspaceId: string | null
  /** A paired client: switching is queued to the host; editing is host-only. */
  mirrored: boolean
  loading: boolean
}

const NEVER_CHANGES = () => () => {}

/** Everything the cogset UI reads, kept live. */
export function useCogsets(): CogsetsView {
  const cogsets = useLiveQuery(() => getDb().pluginCogsets.orderBy("name").toArray(), [])
  const state = useLiveQuery(() => getDb().pluginCogsetState.get(COGSET_STATE_ID), [])
  const override = useCogsetSessionStore((s) => s.overrideCogsetId)
  const activeWorkspaceId = useProjectStore((s) => s.activeProjectId)
  const workspaceBinding = useProjectStore(
    (s) => s.projects.find((project) => project.id === s.activeProjectId)?.pluginCogsetId
  )
  const mirrored = useSyncExternalStore(NEVER_CHANGES, isMirroredPluginClient, () => false)

  const list = cogsets ?? []
  const byId = new Map(list.map((row) => [row.id, row]))
  const candidates: Array<[string | undefined, EffectiveCogsetSource]> = [
    [override, "session"],
    [workspaceBinding, "workspace"],
    [state?.globalCogsetId, "global"],
  ]
  let effective: CogsetsView["effective"] = null
  for (const [id, source] of candidates) {
    const cogset = id ? byId.get(id) : undefined
    if (cogset) {
      effective = { cogset, source }
      break
    }
  }

  return {
    cogsets: list,
    state,
    applied: state?.appliedCogsetId ? byId.get(state.appliedCogsetId) : undefined,
    effective,
    workspaceCogset: workspaceBinding ? byId.get(workspaceBinding) : undefined,
    activeWorkspaceId,
    mirrored,
    loading: cogsets === undefined || state === undefined,
  }
}

/**
 * A cogset's name for display. The bootstrapped Default is stored under a
 * fixed English name and shown localized until the user renames it.
 */
export function useCogsetDisplayName(): (cogset: Pick<CogsetRow, "name" | "source">) => string {
  const t = useTranslations("plugins.cogsets")
  return useCallback(
    (cogset) =>
      cogset.source.kind === "default" && cogset.name === DEFAULT_COGSET_NAME
        ? t("defaultName")
        : cogset.name,
    [t]
  )
}

export interface InstalledPluginSummary {
  id: string
  name: string
  version: string
  enabled: boolean
  source: string
  row: PluginRow
}

/** Installed plugins with localized names, sorted by name, kept live. */
export function useInstalledPluginSummaries(): {
  plugins: InstalledPluginSummary[]
  byId: Map<string, InstalledPluginSummary>
  loading: boolean
} {
  const rows = useLiveQuery(() => getDb().plugins.toArray(), [])
  const locale = useLocale()
  return useMemo(() => {
    const plugins = (rows ?? [])
      .map((row) => ({
        id: row.id,
        name: localizedPluginName(
          { ...(row.manifest as Record<string, unknown>), name: row.name } as Parameters<
            typeof localizedPluginName
          >[0],
          locale
        ),
        version: row.version,
        enabled: row.enabled,
        source: row.source,
        row,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, locale))
    return { plugins, byId: new Map(plugins.map((p) => [p.id, p])), loading: rows === undefined }
  }, [rows, locale])
}
