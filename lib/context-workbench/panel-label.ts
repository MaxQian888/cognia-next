/**
 * One label resolver for every workbench surface that names a panel or an
 * activity.
 *
 * Three surfaces render the same names — the workbench rail/tab strip, the
 * quick-switch palette, and the rail customizer — and each grew its own copy of
 * the lookup. The copies drifted: two of them fell back when a plugin shipped
 * no i18n overlay, while the palette called `t()` on the raw key and threw
 * `MISSING_MESSAGE` the moment a plugin registered an activity of its own
 * (`contextWorkbench.activities.<pluginActivity>` can never exist, because the
 * host does not know the plugin's activity ids at build time).
 *
 * The rules, in one place:
 *
 * - A first-party panel's `labelKey` is a host message key; resolve it directly.
 * - A plugin's `labelKey` is scoped to its own overlay namespace
 *   (`plugin.<pluginId>.<labelKey>`). The overlay is optional, so resolve it
 *   only when the catalogue actually carries the key.
 * - Failing that, use the literal `label` the plugin registered, then the key
 *   itself, then whatever the call site can name it.
 */

/**
 * A `next-intl` root translator. `has()` is present at runtime but absent from
 * the published type, which is why every call site has to widen it — doing that
 * here means no caller repeats the cast.
 */
export type WorkbenchLabelTranslator = ((key: never) => string) & {
  has?: (candidate: string) => boolean
}

/** The label-bearing fields shared by panel definitions and rail catalog rows. */
export interface WorkbenchLabelSource {
  /** Message key: a host key for first-party panels, overlay-scoped for plugins. */
  labelKey?: string
  /** Literal label a plugin registered, used when it ships no i18n overlay. */
  label?: string
  /** Set when the panel — or the activity it created — came from a plugin. */
  pluginId?: string
}

/**
 * Resolve a plugin-contributed panel or activity label.
 *
 * Only for sources with a `pluginId`; a first-party key belongs to its own
 * namespace (`contextWorkbench.panels.*` vs `contextWorkbench.activities.*`)
 * and the call site resolves it directly.
 */
export function resolvePluginWorkbenchLabel(
  t: WorkbenchLabelTranslator,
  source: WorkbenchLabelSource,
  fallback: string
): string {
  const overlayKey =
    source.pluginId && source.labelKey ? `plugin.${source.pluginId}.${source.labelKey}` : null
  if (overlayKey && typeof t.has === "function" && t.has(overlayKey)) {
    return t(overlayKey as never)
  }
  return source.label ?? source.labelKey ?? fallback
}

/**
 * Resolve any panel label, first-party or plugin.
 *
 * `fallback` is the last resort — the panel id at most call sites, so a panel
 * that somehow carries neither key nor label is still selectable rather than
 * blank.
 */
export function resolveWorkbenchPanelLabel(
  t: WorkbenchLabelTranslator,
  panel: WorkbenchLabelSource,
  fallback: string
): string {
  if (!panel.pluginId) {
    return panel.labelKey ? t(panel.labelKey as never) : fallback
  }
  return resolvePluginWorkbenchLabel(t, panel, fallback)
}
