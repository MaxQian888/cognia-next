/**
 * Loading and containment for `manifest.styles`.
 *
 * A plugin's stylesheet is injected into the host document, so it needs the
 * styling equivalent of the per-extension `ErrorBoundary`: a plugin that writes
 * `.badge { … }` must restyle its own subtree and nothing else. Every surface
 * that renders plugin content stamps `data-plugin-root="<id>"` on its wrapper,
 * and the stylesheet is wrapped in `@scope ([data-plugin-root="<id>"])`.
 *
 * `@scope` was chosen over rewriting selectors because it needs no CSS parser —
 * the browser applies the bound, so there is no selector syntax we can get
 * wrong. The one thing it cannot hold is the at-rules that *define a name*
 * rather than style an element: `@keyframes`, `@font-face`, `@property` and
 * `@counter-style` are invalid inside a `@scope` block and would be dropped
 * silently. Since animation is one of the things this feature exists to enable,
 * those are hoisted back out to the top level — which makes their names global.
 * See `docs/content/docs/plugin-dev/surfaces.mdx`.
 */

import { loggers } from "@cognia/logging"

const stylesLogger = loggers.plugin.child("styles")

/** Attribute every plugin-owned wrapper carries; the scope root selector. */
export const PLUGIN_ROOT_ATTRIBUTE = "data-plugin-root"

/** Marks the injected `<style>` so teardown can find it again. */
export const PLUGIN_STYLE_ATTRIBUTE = "data-plugin-styles"

/**
 * At-rules that bind a *name* into a global namespace instead of styling an
 * element. They are invalid inside `@scope`, so they are hoisted out of it.
 */
const HOISTED_AT_RULES = ["keyframes", "font-face", "property", "counter-style", "import"]

/**
 * Split CSS into the chunks that must stay outside `@scope` and everything
 * else, tracking brace depth so only *top-level* at-rules are hoisted (a
 * `@keyframes` nested in `@media` is already inside a rule and stays put).
 *
 * Strings and comments are skipped explicitly: a brace inside `content: "}"`
 * would otherwise unbalance the scan and split the sheet in the wrong place.
 */
export function splitHoistedAtRules(css: string): { hoisted: string; scoped: string } {
  const hoisted: string[] = []
  const scoped: string[] = []

  let index = 0
  let depth = 0
  let chunkStart = 0
  let chunkIsHoisted = false

  const flush = (end: number) => {
    const chunk = css.slice(chunkStart, end)
    if (chunk.trim()) (chunkIsHoisted ? hoisted : scoped).push(chunk.trim())
    chunkStart = end
    chunkIsHoisted = false
  }

  while (index < css.length) {
    const char = css[index]

    if (char === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2)
      index = close === -1 ? css.length : close + 2
      continue
    }

    if (char === '"' || char === "'") {
      index = skipString(css, index)
      continue
    }

    if (char === "@" && depth === 0) {
      // A new top-level at-rule begins: close out whatever preceded it so the
      // hoisting decision applies to this rule alone.
      flush(index)
      const name = /^@([a-zA-Z-]+)/.exec(css.slice(index))?.[1]?.toLowerCase()
      chunkIsHoisted = name !== undefined && HOISTED_AT_RULES.includes(name)
      index += 1
      continue
    }

    if (char === "{") {
      depth += 1
      index += 1
      continue
    }

    if (char === "}") {
      depth -= 1
      index += 1
      if (depth <= 0) {
        depth = 0
        flush(index)
      }
      continue
    }

    // `@import`/`@charset` are statement at-rules — they end at `;`, not `}`.
    if (char === ";" && depth === 0) {
      index += 1
      flush(index)
      continue
    }

    index += 1
  }
  flush(css.length)

  return { hoisted: hoisted.join("\n"), scoped: scoped.join("\n") }
}

function skipString(css: string, start: number): number {
  const quote = css[start]
  let index = start + 1
  while (index < css.length) {
    if (css[index] === "\\") {
      index += 2
      continue
    }
    if (css[index] === quote) return index + 1
    index += 1
  }
  return css.length
}

/**
 * Bound a plugin's stylesheet to its own subtree. Returns CSS ready to inject.
 *
 * `pluginId` is embedded in an attribute selector, so it is escaped rather than
 * interpolated raw — a manifest id is validated upstream, but a stylesheet that
 * silently mis-scopes because of one stray quote is a bad failure mode.
 */
export function scopePluginCss(css: string, pluginId: string): string {
  const { hoisted, scoped } = splitHoistedAtRules(css)
  const selector = `[${PLUGIN_ROOT_ATTRIBUTE}="${cssEscapeAttributeValue(pluginId)}"]`

  const parts: string[] = []
  if (hoisted) {
    parts.push(`/* hoisted out of @scope — these define global names */\n${hoisted}`)
  }
  if (scoped) {
    parts.push(`@scope (${selector}) {\n${scoped}\n}`)
  }
  return parts.join("\n\n")
}

function cssEscapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

/**
 * Inject (or replace) a plugin's stylesheet. Idempotent per plugin id, so a
 * reload during `plugin dev` swaps the rules instead of stacking them.
 */
export function injectPluginStyles(pluginId: string, css: string): void {
  if (typeof document === "undefined") return

  const scoped = scopePluginCss(css, pluginId)
  const existing = document.querySelector<HTMLStyleElement>(
    `style[${PLUGIN_STYLE_ATTRIBUTE}="${CSS.escape(pluginId)}"]`
  )
  const element = existing ?? document.createElement("style")
  element.setAttribute(PLUGIN_STYLE_ATTRIBUTE, pluginId)
  element.textContent = scoped
  if (!existing) document.head.appendChild(element)
}

/** Remove a plugin's stylesheet. Safe to call when nothing was injected. */
export function removePluginStyles(pluginId: string): void {
  if (typeof document === "undefined") return
  document
    .querySelectorAll(`style[${PLUGIN_STYLE_ATTRIBUTE}="${CSS.escape(pluginId)}"]`)
    .forEach((node) => node.remove())
}

export interface LoadPluginStylesOptions {
  pluginId: string
  /** Install root, e.g. the directory holding plugin.json. */
  pluginRoot: string
  /** `manifest.styles` — repo-relative path to the stylesheet. */
  stylesEntry: string | undefined
  /** Injected for tests; defaults to the Tauri contained-read command. */
  readFile?: (pluginId: string, pluginRoot: string, entry: string) => Promise<string>
}

/**
 * Read and inject a plugin's declared stylesheet.
 *
 * Failure is non-fatal and logged: a plugin whose CSS is missing should still
 * load with its behavior intact rather than refusing to activate. It is *not*
 * silent, though — a stylesheet that quietly does nothing is the exact defect
 * this function exists to fix.
 */
export async function loadPluginStyles({
  pluginId,
  pluginRoot,
  stylesEntry,
  readFile = readPluginFileViaTauri,
}: LoadPluginStylesOptions): Promise<boolean> {
  if (!stylesEntry) return false
  // Built-ins are compiled into the app bundle and have no fetchable install
  // directory, so there is nothing to read. They style themselves with Tailwind.
  if (pluginRoot.startsWith("builtin://")) {
    stylesLogger.debug("skipping styles for builtin plugin", { pluginId })
    return false
  }

  try {
    const css = await readFile(pluginId, pluginRoot, stylesEntry)
    injectPluginStyles(pluginId, css)
    return true
  } catch (error) {
    stylesLogger.warn("failed to load plugin stylesheet", {
      pluginId,
      stylesEntry,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function readPluginFileViaTauri(
  pluginId: string,
  pluginRoot: string,
  entry: string
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<string>("plugin_read_entry", { pluginId, pluginPath: pluginRoot, entry })
}
