/**
 * Type contracts for plugin-contributed modal mounts.
 *
 * Two surfaces:
 *
 * 1. **Imperative** — `ctx.modal.openModal(component, props)` returns a modal
 *    id; plugins can also `closeModal(id)`. The host renders the stack via
 *    `components/plugins/plugin-modal-root.tsx`, mounted once in
 *    `app/layout.tsx`. State lives in `stores/plugin/plugin-modal-store.ts`.
 *
 * 2. **Declarative** — `manifest.modalMounts[]` reserves a known modal id
 *    that the host can resolve and open via a deep link, slash command, or
 *    extension-point host. Useful when a plugin wants the modal to be
 *    available before any of its own JS has activated.
 *
 * Permission gate: `extension:ui`. See ADR-0026.
 */

import type React from "react"

/**
 * One declarative modal contribution in `manifest.modalMounts[]`.
 *
 * Modals declared this way are not auto-opened — the host caches the
 * factory and surfaces the id; opening still flows through
 * `ctx.modal.openModal(id, props)` or a slash-command handler.
 */
export interface PluginModalMountDef {
  /**
   * Modal id, unprefixed. The host prefixes with the plugin id at
   * registration time so two plugins cannot collide.
   */
  id: string
  /** Human label shown in plugin settings and the deep-link UI. */
  label: string
  /** Relative path inside the plugin install root. */
  entry: string
  /**
   * Named export on the entry module — must resolve to a
   * `React.ComponentType<PluginModalProps>`.
   */
  export: string
}

export interface PluginModalProps {
  /**
   * Called by the modal component when the user dismisses it. Pops the
   * stack and clears state.
   */
  onClose(): void
  /**
   * The id assigned by the modal store; useful when the same component
   * is opened in multiple stacked instances.
   */
  modalId: string
  /**
   * Plugin-defined arguments passed through `openModal(component, props)`.
   * Type-narrow at the use site.
   */
  args?: Record<string, unknown>
}

export type PluginModalComponent = React.ComponentType<PluginModalProps>

/**
 * Stack entry tracked by `plugin-modal-store`. One per open modal.
 */
export interface PluginModalEntry {
  modalId: string
  pluginId: string
  /** Either a resolved component (imperative) or a declarative id key. */
  component: PluginModalComponent
  args?: Record<string, unknown>
  openedAt: number
}

/**
 * Handle returned by `ctx.modal.openModal(...)`. `close()` is idempotent.
 */
export interface PluginModalHandle {
  modalId: string
  close(): void
}
