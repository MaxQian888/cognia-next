"use client"

/**
 * Item-level favorites for the discover page. Mirrors
 * `components/workflow/library/use-pinned-workflows.ts`: a flat string array on
 * the settings singleton (`discoverFavorites`), written via
 * `useSettingsStore.save()` so it syncs cross-device with no Dexie migration.
 *
 * Keys are `${kind}:${id}` (e.g. `character:abc`) so a favorite is unique
 * across discover kinds — a plugin and a character can share an id without
 * colliding.
 */

import { useCallback, useMemo } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"

/** Build the stable `${kind}:${id}` favorite key. */
export function favoriteKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

export interface UseDiscoverFavorites {
  /** All favorite keys as a set for O(1) membership tests. */
  favoriteKeys: ReadonlySet<string>
  isFavorite: (kind: string, id: string) => boolean
  toggleFavorite: (kind: string, id: string) => Promise<void>
}

export function useDiscoverFavorites(): UseDiscoverFavorites {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const favorites = settings?.discoverFavorites
  const favoriteKeys = useMemo(() => new Set(favorites ?? []), [favorites])

  const isFavorite = useCallback(
    (kind: string, id: string) => favoriteKeys.has(favoriteKey(kind, id)),
    [favoriteKeys]
  )

  const toggleFavorite = useCallback(
    async (kind: string, id: string) => {
      const key = favoriteKey(kind, id)
      const current = favorites ?? []
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
      await save({ discoverFavorites: next })
    },
    [favorites, save]
  )

  return { favoriteKeys, isFavorite, toggleFavorite }
}
