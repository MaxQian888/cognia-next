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
import type { PluginModalComponent, PluginModalEntry } from "@/types/plugin/plugin-modal"

interface PluginModalState {
  stack: PluginModalEntry[]
  open(args: {
    pluginId: string
    component: PluginModalComponent
    args?: Record<string, unknown>
  }): string
  close(modalId: string): void
  closeAll(): void
  clearByPlugin(pluginId: string): void
}

export const usePluginModalStore = create<PluginModalState>((set, get) => ({
  stack: [],
  open({ pluginId, component, args }) {
    const modalId = `modal_${nanoid(10)}`
    const entry: PluginModalEntry = {
      modalId,
      pluginId,
      component,
      args,
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
