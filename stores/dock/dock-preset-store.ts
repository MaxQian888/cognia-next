/**
 * Saved dock arrangements, per host.
 *
 * Separate from `dock-layout-store` because they answer different questions and
 * have different lifetimes: a layout is "what is on screen in this session
 * right now" and is pruned aggressively; a preset is "an arrangement I want to
 * come back to" and should outlive every context it was captured from.
 *
 * Presets carry no context identity (see `types/dock/preset`), so unlike
 * layouts they are keyed only by host — one list of chat presets, usable in any
 * chat session.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { normalizeDockPresetName, uniqueDockPresetName } from "@/lib/dock/presets/naming"
import type { DockHost } from "@/types/dock/layout"
import type { DockPreset } from "@/types/dock/preset"

/** Ceiling per host. Presets are user-authored, so this is generous. */
export const DOCK_PRESET_LIMIT_PER_HOST = 50

export interface DockPresetStoreState {
  presets: Record<string, DockPreset>
  /** host → preset id applied to a fresh context. */
  defaults: Partial<Record<DockHost, string>>

  listPresets: (host: DockHost) => DockPreset[]
  getPreset: (id: string) => DockPreset | undefined
  getDefaultPreset: (host: DockHost) => DockPreset | undefined

  /**
   * Store a preset, renaming it if the host already has that name. Returns the
   * stored preset (whose name may differ from the one handed in) or `null` when
   * the host is at its limit.
   */
  savePreset: (
    preset: DockPreset,
    format: (name: string, count: number) => string
  ) => DockPreset | null
  renamePreset: (
    id: string,
    name: string,
    format: (name: string, count: number) => string
  ) => boolean
  deletePreset: (id: string) => boolean
  setDefaultPreset: (host: DockHost, id: string | null) => boolean
}

function presetsOfHost(
  presets: Record<string, DockPreset>,
  host: DockHost,
  exceptId?: string
): DockPreset[] {
  return Object.values(presets).filter((p) => p.host === host && p.id !== exceptId)
}

export const useDockPresetStore = create<DockPresetStoreState>()(
  persist(
    (set, get) => ({
      presets: {},
      defaults: {},

      listPresets: (host) =>
        presetsOfHost(get().presets, host).sort((a, b) => {
          // Built-ins first — they are the starting points, not the user's own
          // work — then most-recently-updated.
          if (Boolean(a.builtin) !== Boolean(b.builtin)) return a.builtin ? -1 : 1
          return b.updatedAt - a.updatedAt
        }),

      getPreset: (id) => get().presets[id],

      getDefaultPreset: (host) => {
        const id = get().defaults[host]
        return id ? get().presets[id] : undefined
      },

      savePreset: (preset, format) => {
        const siblings = presetsOfHost(get().presets, preset.host, preset.id)
        if (!get().presets[preset.id] && siblings.length >= DOCK_PRESET_LIMIT_PER_HOST) return null
        const stored: DockPreset = {
          ...preset,
          name: uniqueDockPresetName({
            name: preset.name,
            taken: siblings.map((p) => p.name),
            format,
          }),
        }
        set((state) => ({ presets: { ...state.presets, [stored.id]: stored } }))
        return stored
      },

      renamePreset: (id, name, format) => {
        const existing = get().presets[id]
        // A built-in is a fixed starting point; renaming one would make the
        // list stop matching what the docs and the reset command refer to.
        if (!existing || existing.builtin) return false
        const normalized = normalizeDockPresetName(name)
        if (normalized.length === 0) return false
        const stored: DockPreset = {
          ...existing,
          name: uniqueDockPresetName({
            name: normalized,
            taken: presetsOfHost(get().presets, existing.host, id).map((p) => p.name),
            format,
          }),
          updatedAt: Date.now(),
        }
        set((state) => ({ presets: { ...state.presets, [id]: stored } }))
        return true
      },

      deletePreset: (id) => {
        const existing = get().presets[id]
        if (!existing || existing.builtin) return false
        set((state) => {
          const { [id]: _dropped, ...presets } = state.presets
          // Deleting the default leaves the host with none rather than
          // silently promoting an arbitrary neighbour.
          const defaults =
            state.defaults[existing.host] === id
              ? { ...state.defaults, [existing.host]: undefined }
              : state.defaults
          return { presets, defaults }
        })
        return true
      },

      setDefaultPreset: (host, id) => {
        if (id === null) {
          set((state) => ({ defaults: { ...state.defaults, [host]: undefined } }))
          return true
        }
        const preset = get().presets[id]
        if (!preset || preset.host !== host) return false
        set((state) => ({ defaults: { ...state.defaults, [host]: id } }))
        return true
      },
    }),
    {
      name: "cognia-dock-presets-v1",
      version: 1,
      storage: persistLocalStorage(),
      partialize: (state) => ({ presets: state.presets, defaults: state.defaults }),
    }
  )
)
