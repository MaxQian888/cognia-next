"use client"

/**
 * Plugin-contributed skills as pickable options.
 *
 * The send path already resolves any explicit skill id found in the plugin
 * skill registry (`build-options.ts`: ephemeral ids → `resolveSkillsForCharacter`)
 * and every id in `character.pluginSkillIds`. What was missing was a way for a
 * user to pick one: every skill picker listed Dexie chat skills only, so a
 * plugin's skill could run only if a character pack or team template happened
 * to attach it. This hook is the registry side of those pickers.
 *
 * `PluginSkillDef.scope` decides where a skill is offered:
 *   - unset / `"global"` → every picker
 *   - `"character"`      → character settings only
 *   - `"team"`           → team pickers only
 */

import { useMemo, useSyncExternalStore } from "react"

import {
  getSkillsRevision,
  listSkillEntries,
  subscribeToSkills,
} from "@/lib/plugin/registries/skill-registry"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"

export type PluginSkillSurface = "session" | "character" | "team"

export interface PluginSkillOption {
  /** Registry id — what `ephemeralSkillIds` / `pluginSkillIds` carry. */
  id: string
  name: string
  description?: string
  pluginId?: string
}

function offeredOn(scope: PluginSkillDef["scope"], surface: PluginSkillSurface): boolean {
  if (!scope || scope === "global") return true
  return scope === surface
}

/** Pure projection of registry entries for one picker surface, sorted by name. */
export function selectPluginSkills(
  entries: ReadonlyArray<{ id: string; entry: PluginSkillDef; pluginId?: string }>,
  surface: PluginSkillSurface
): PluginSkillOption[] {
  return entries
    .filter(({ entry }) => offeredOn(entry.scope, surface))
    .map(({ id, entry, pluginId }) => ({
      id,
      name: entry.name || id,
      description: entry.description || undefined,
      pluginId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Every registered plugin skill offered on `surface`; live as plugins enable/disable. */
export function usePluginSkills(surface: PluginSkillSurface, enabled = true): PluginSkillOption[] {
  const revision = useSyncExternalStore(subscribeToSkills, getSkillsRevision, () => 0)
  return useMemo(() => {
    // Read so a registry change yields a fresh projection.
    void revision
    return enabled ? selectPluginSkills(listSkillEntries(), surface) : []
  }, [revision, enabled, surface])
}

/** Registry lookup (any scope) for chips and badges that hold a plugin skill id. */
export function usePluginSkillsById(): ReadonlyMap<string, PluginSkillOption> {
  const revision = useSyncExternalStore(subscribeToSkills, getSkillsRevision, () => 0)
  return useMemo(() => {
    void revision
    return new Map(
      listSkillEntries().map(({ id, entry, pluginId }) => [
        id,
        { id, name: entry.name || id, description: entry.description || undefined, pluginId },
      ])
    )
  }, [revision])
}
