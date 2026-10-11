/**
 * Plugin glance modules (`manifest.glanceModules`, capability `glance`,
 * runtime point `glance.module`, ADR-0225 §6).
 *
 * A plugin contributes a module to the desktop tray panel and the phone's
 * Glance drawer as DATA: a declaration (title, icon, sizes, platforms) plus
 * what it publishes for it (stats, rows, actions, a summary line). It never
 * ships React into a glance surface. The tray panel is a separate webview, a
 * paired phone may be rendering the desktop's snapshot, and the visual
 * language must not fork, so the host renders the data with the same
 * components as its own modules.
 *
 * These shapes mirror the host's `lib/glance/plugin-data.ts` structurally;
 * they live here so the author SDK can describe them without importing host
 * code. The host sanitizes everything on the way in: unknown fields are
 * dropped, strings are trimmed and capped, lists are truncated (limits on
 * each field below).
 */

import type { PluginIconName } from "./plugin-icon"

/** How much room a module takes: one line, the default body, or full detail. */
export type PluginGlanceModuleSize = "compact" | "standard" | "expanded"

/** Glance surfaces: the desktop tray panel, or the phone home and Glance drawer. */
export type PluginGlancePlatform = "desktop" | "mobile"

/** Text colours a plugin may use, the host modules' own vocabulary. */
export type PluginGlanceTone = "default" | "ok" | "warn" | "crit" | "muted"

/**
 * A module declaration, from `manifest.glanceModules[]` or
 * `ctx.glance.register`.
 */
export interface PluginManifestGlanceModuleDef {
  /**
   * Local id, unique within the plugin: letters, digits, `.`, `_`, `-`,
   * starting with a letter or digit, at most 64 characters. The host keys the
   * module as `plugin:<pluginId>:<id>` in the user's layout.
   */
  id: string
  /** Literal title (at most 48 characters), the fallback for `titleKey`. */
  title: string
  /** Plugin i18n key preferred over `title` for the active locale. */
  titleKey?: string
  /** Exported lucide-react icon name. */
  icon?: PluginIconName
  /** Sizes the module renders, smallest first. Defaults to compact + standard. */
  sizes?: PluginGlanceModuleSize[]
  /** Surfaces the module renders on. Defaults to both. */
  platforms?: PluginGlancePlatform[]
}

/** What `ctx.glance.register` takes: the same shape as a manifest entry. */
export type PluginGlanceModuleInput = PluginManifestGlanceModuleDef

/** One number and caption of the stats strip. */
export interface PluginGlanceStat {
  /** At most 48 characters. */
  label: string
  /** Preformatted value, at most 24 characters. */
  value: string
  tone?: PluginGlanceTone
}

/** One row of the module body. */
export interface PluginGlanceRow {
  /** Local id, unique within the published data. */
  id: string
  /** At most 48 characters. */
  label: string
  /** At most 24 characters. */
  value?: string
  /** Secondary line, at most 80 characters. */
  hint?: string
  tone?: PluginGlanceTone
  /** Id of one of the published `actions`, run when the row is clicked. */
  action?: string
}

/** One button, bound to one of the plugin's own commands. */
export interface PluginGlanceAction {
  /** Local id, unique within the published data. */
  id: string
  /** At most 48 characters. */
  label: string
  /** Exported lucide-react icon name. */
  icon?: PluginIconName
  /**
   * The plugin's own command id WITHOUT its plugin prefix. The host runs
   * `<pluginId>.<command>`, so a module can only trigger its own plugin.
   */
  command: string
}

/**
 * What `ctx.glance.update` publishes for one module. Limits: at most 4
 * stats, 8 rows and 3 actions; `summary` at most 80 characters, `empty` at
 * most 120.
 */
export interface PluginGlanceModuleData {
  stats?: PluginGlanceStat[]
  rows?: PluginGlanceRow[]
  actions?: PluginGlanceAction[]
  /** One line for the compact size; defaults to the first stat. */
  summary?: string
  /** Shown when there are no stats and no rows. */
  empty?: string
}

/**
 * Glance API surfaced via `ctx.glance`. Available only when the plugin
 * declares the `"glance"` capability; otherwise a warn-once no-op.
 *
 * Modules are rendered by the host with its own components (no React from
 * the plugin). Everything handed over is capped and sanitized: at most 8
 * modules per plugin; per module at most 4 stats, 8 rows and 3 actions;
 * titles and labels at most 48 characters, values 24, hints and the summary
 * 80, the empty text 120. Actions run the plugin's own commands
 * (`<pluginId>.<command>`). On a paired phone the module is read-only: it
 * shows the desktop's data, and its actions are shown disabled.
 */
export interface PluginGlanceAPI {
  /**
   * Declare a module at runtime, the imperative twin of
   * `manifest.glanceModules[]`. Re-declaring an id updates its title, icon,
   * sizes and platforms and keeps its data. Returns a disposer that removes
   * the module (or, for an id the manifest also declares, restores the
   * manifest's declaration). Every runtime module is removed when the plugin
   * is disabled; the user's layout keeps its place so re-enabling restores
   * it. Throws for an invalid declaration (bad id, no title) or past the
   * 8-module limit.
   */
  register: (module: PluginGlanceModuleInput) => () => void
  /**
   * Publish data for a declared module, replacing what it showed; `null`
   * clears it back to the empty state. The data is sanitized and capped (see
   * {@link PluginGlanceModuleData}); a row pointing at an action that is not
   * in `actions` loses the pointer. Throws for a module the plugin has not
   * declared.
   */
  update: (moduleId: string, data: PluginGlanceModuleData | null) => void
  /**
   * Hear when a module comes into or goes out of view on any glance surface
   * (the tray panel, a phone drawer). The handler is called at once with the
   * current state, so a plugin can start or stop the work behind a module
   * without a second read. Returns a disposer.
   */
  onVisibilityChange: (moduleId: string, handler: (visible: boolean) => void) => () => void
}
