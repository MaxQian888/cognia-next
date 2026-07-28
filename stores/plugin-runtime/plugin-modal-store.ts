/**
 * Plugin Modal Stack Store.
 *
 * Holds the LIFO stack of modals plugins have opened via
 * `ctx.modal.openModal(component, props)`. `<PluginModalRoot />` (mounted
 * once in `app/layout.tsx`) renders the top-of-stack entry inside a
 * shadcn `Dialog`.
 *
 * Modal ids are generated host-side with `nanoid()` so plugin authors
 * don't need to invent unique ids manually. The store also tracks the
 * owning plugin id so `clearModalsForPlugin(pluginId)` can drop every
 * modal that plugin opened on disable.
 *
 * ADR-0026 §3 §A.
 */

import { create } from "zustand"
import { nanoid } from "nanoid"
import {
  resolvePluginModalOptions,
  type PluginModalComponent,
  type PluginModalEntry,
  type PluginModalOptions,
} from "@/types/plugin/plugin-modal"

interface PluginModalState {
  stack: PluginModalEntry[]
  open(args: {
    pluginId: string
    component: PluginModalComponent
    args?: Record<string, unknown>
    options?: PluginModalOptions
  }): string
  close(modalId: string): void
  closeAll(): void
  clearByPlugin(pluginId: string): void
}

export const usePluginModalStore = create<PluginModalState>((set, get) => ({
  stack: [],
  open({ pluginId, component, args, options }) {
    const modalId = `modal_${nanoid(10)}`
    const entry: PluginModalEntry = {
      modalId,
      pluginId,
      component,
      args,
      options,
      openedAt: Date.now(),
    }
    set((state) => ({ stack: [...state.stack, entry] }))
    return modalId
  },
  close(modalId) {
    set((state) => ({ stack: state.stack.filter((entry) => entry.modalId !== modalId) }))
  },
  closeAll() {
    if (get().stack.length === 0) return
    set({ stack: [] })
  },
  clearByPlugin(pluginId) {
    set((state) => ({
      stack: state.stack.filter((entry) => entry.pluginId !== pluginId),
    }))
  },
}))

/** Selector — the topmost (most recently opened) modal, or undefined. */
export function selectTopModal(state: PluginModalState): PluginModalEntry | undefined {
  return state.stack[state.stack.length - 1]
}

/** Selector — every modal currently on the stack. */
export function selectAllModals(state: PluginModalState): PluginModalEntry[] {
  return state.stack
}

/**
 * Plugin-disable hook — drop every modal the plugin owns. Called by the
 * plugin manager during disable/unload.
 */
export function clearModalsForPlugin(pluginId: string): void {
  usePluginModalStore.getState().clearByPlugin(pluginId)
}

// ─────────────────────────────────────────────────────────────────────────
// Declarative modal registry (`manifest.modalMounts[]`)
//
// Distinct from the imperative open-stack above: a declared modal reserves a
// known id whose component is lazily resolved the first time it is opened (via
// a deep link, slash command, or `ctx.modal.openById`). The registry stores a
// loader closure (bound to the plugin's importer) rather than a live
// component, so nothing is imported until the modal is actually opened.
// ADR-0026 §3 §A — the declarative half the imperative path deferred.
// ─────────────────────────────────────────────────────────────────────────

export interface DeclaredModalEntry {
  pluginId: string
  /** Unprefixed modal id, as declared in `manifest.modalMounts[].id`. */
  id: string
  label: string
  /** Plugin i18n key preferred over the literal label by discovery UI. */
  labelKey?: string
  /**
   * Presentation declared in `manifest.modalMounts[].options`, used as the base
   * layer for every open of this modal. A call-site `options` overrides it
   * field by field.
   */
  options?: PluginModalOptions
  /** Lazily resolve the modal component (null if the import/export fails). */
  load: () => Promise<PluginModalComponent | null>
}

const declaredModals = new Map<string, DeclaredModalEntry>()
const declaredListeners = new Set<() => void>()
let declaredSnapshot: DeclaredModalEntry[] | null = null

function declaredKey(pluginId: string, id: string): string {
  return `${pluginId}:${id}`
}

function notifyDeclared(): void {
  declaredSnapshot = null
  for (const fn of declaredListeners) {
    try {
      fn()
    } catch {
      // A listener throwing must not block the rest.
    }
  }
}

/** Register (or replace) a declarative modal. Keyed by `<pluginId>:<id>`. */
export function registerDeclaredModal(entry: DeclaredModalEntry): void {
  declaredModals.set(declaredKey(entry.pluginId, entry.id), entry)
  notifyDeclared()
}

/** Drop every declarative modal the plugin registered. Returns the count. */
export function unregisterDeclaredModalsForPlugin(pluginId: string): number {
  let removed = 0
  for (const [k, entry] of declaredModals) {
    if (entry.pluginId === pluginId) {
      declaredModals.delete(k)
      removed += 1
    }
  }
  if (removed > 0) notifyDeclared()
  return removed
}

export function getDeclaredModal(pluginId: string, id: string): DeclaredModalEntry | undefined {
  return declaredModals.get(declaredKey(pluginId, id))
}

export function listDeclaredModals(): DeclaredModalEntry[] {
  if (!declaredSnapshot) declaredSnapshot = [...declaredModals.values()]
  return declaredSnapshot
}

export function subscribeDeclaredModals(listener: () => void): () => void {
  declaredListeners.add(listener)
  return () => {
    declaredListeners.delete(listener)
  }
}

/**
 * Resolve a declared modal's component and push it onto the open stack.
 * Returns the new modal id, or null when the modal id is unknown or its
 * component fails to load.
 */
export async function openDeclaredModal(
  pluginId: string,
  id: string,
  args?: Record<string, unknown>,
  options?: PluginModalOptions
): Promise<string | null> {
  const def = getDeclaredModal(pluginId, id)
  if (!def) return null
  const component = await def.load()
  if (!component) return null
  // Field-by-field merge, not object replacement: a call site that only wants a
  // different `size` must not silently drop the `variant` the manifest declared.
  // Routed through the shared resolver rather than an object spread so an
  // explicit `{ variant: undefined }` from a caller degrades to "unspecified"
  // instead of erasing the declared default.
  const merged =
    def.options || options ? resolvePluginModalOptions(def.options, options) : undefined
  return usePluginModalStore.getState().open({ pluginId, component, args, options: merged })
}

/** Test-only — wipe the declarative registry. */
export function __resetDeclaredModalsForTesting(): void {
  declaredModals.clear()
  declaredListeners.clear()
  declaredSnapshot = null
}
