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
 * Presentation controls a plugin may ask for when opening a modal.
 *
 * Runtime arrays rather than bare unions because both halves of the contract
 * need to *check* a value, not just type it: the manifest validator rejects a
 * bad `modalMounts[].options` at install time, and the renderer has to survive
 * a plugin passing anything at all through the imperative API (plugin code is
 * untyped JS by the time it reaches us). One source, so the two cannot drift
 * the way `resourceKinds` did — see `CONTEXT_RESOURCE_READ_PERMISSIONS`.
 */
export const PLUGIN_MODAL_SIZES = ["sm", "md", "lg", "full"] as const
export type PluginModalSize = (typeof PLUGIN_MODAL_SIZES)[number]

export const PLUGIN_MODAL_VARIANTS = ["center", "sheet-right", "sheet-bottom"] as const
export type PluginModalVariant = (typeof PLUGIN_MODAL_VARIANTS)[number]

/**
 * The pre-options behaviour, pinned as the default on purpose: every call that
 * omits `options` (which is every call written before this existed) must keep
 * producing exactly the centered, `sm:max-w-lg` dialog it produced before.
 */
export const DEFAULT_PLUGIN_MODAL_SIZE: PluginModalSize = "md"
export const DEFAULT_PLUGIN_MODAL_VARIANT: PluginModalVariant = "center"

export interface PluginModalOptions {
  /** Width preset for `center`/`sheet-right`, height preset for `sheet-bottom`. */
  size?: PluginModalSize
  /** Where the modal is anchored. Defaults to the centered dialog. */
  variant?: PluginModalVariant
}

/** `PluginModalOptions` after defaults are applied — what the renderer reads. */
export interface ResolvedPluginModalOptions {
  size: PluginModalSize
  variant: PluginModalVariant
}

function isPluginModalSize(value: unknown): value is PluginModalSize {
  return PLUGIN_MODAL_SIZES.includes(value as PluginModalSize)
}

function isPluginModalVariant(value: unknown): value is PluginModalVariant {
  return PLUGIN_MODAL_VARIANTS.includes(value as PluginModalVariant)
}

/**
 * Fold layered option sources into one resolved pair, later sources winning.
 *
 * Two layers exist today: what `manifest.modalMounts[].options` declared, and
 * what the `openById`/`openModal` call site passed. Unrecognised values are
 * dropped rather than thrown on — a modal that renders centered is a far better
 * outcome for the user than one that does not render at all, and the manifest
 * validator already gives the *author* the loud version of the same message.
 */
export function resolvePluginModalOptions(
  ...sources: (PluginModalOptions | undefined)[]
): ResolvedPluginModalOptions {
  let size: PluginModalSize = DEFAULT_PLUGIN_MODAL_SIZE
  let variant: PluginModalVariant = DEFAULT_PLUGIN_MODAL_VARIANT
  for (const source of sources) {
    if (!source) continue
    if (isPluginModalSize(source.size)) size = source.size
    if (isPluginModalVariant(source.variant)) variant = source.variant
  }
  return { size, variant }
}

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
  /** Plugin i18n key preferred over `label` when present for the active locale. */
  labelKey?: string
  /** Relative path inside the plugin install root. */
  entry: string
  /**
   * Named export on the entry module — must resolve to a
   * `React.ComponentType<PluginModalProps>`.
   */
  export: string
  /**
   * Default presentation for this modal, applied to every route that opens it.
   *
   * The imperative API can pass `options` per call, but a declared modal is
   * reachable from places with no call site to pass anything — a deep link, a
   * slash command, the plugin-detail UI. Without a declared default those
   * routes could only ever produce a centered dialog, so a plugin whose modal
   * is designed as a right-side sheet would render wrong exactly where it has
   * the least control. Call-site `options` still win, field by field.
   */
  options?: PluginModalOptions
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
  /**
   * Presentation the opener asked for, already merged across the declarative
   * and call-site layers. Left raw (not resolved) so the store stays a dumb
   * container and `<PluginModalRoot />` remains the single place that decides
   * what an unset — or bogus — value means.
   */
  options?: PluginModalOptions
  openedAt: number
}

/**
 * Handle returned by `ctx.modal.openModal(...)`. `close()` is idempotent.
 */
export interface PluginModalHandle {
  modalId: string
  close(): void
}
