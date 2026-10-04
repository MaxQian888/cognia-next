/**
 * Inline boot script — pre-hydration FOUC mitigation.
 *
 * Mounted into `<head>` via `<Script strategy="beforeInteractive">` in
 * `app/layout.tsx`. Runs synchronously before React hydrates so a user
 * who has an active custom theme + wallpaper doesn't see a one-frame
 * flash of the default palette while `SettingsHydrator` waits for Dexie
 * to resolve.
 *
 * Contract:
 *  - Reads `localStorage["cognia.appearance.mirror"]` — a tiny JSON
 *    snapshot of the 4 most visible CSS vars (`--foreground`, `--background`,
 *    `--primary`, `--accent`) written by `SettingsHydrator` after every
 *    appearance-store mutation.
 *  - Does NOT touch the `dark` class on `<html>` — next-themes owns that
 *    via its own pre-hydration script. Writing it from both places would
 *    race the hydration check.
 *  - Silently falls through on any parse / DOM error so a corrupted
 *    mirror entry never breaks first paint.
 */

/** Keys mirrored to localStorage and applied by the boot script. */
export const BOOT_MIRROR_KEYS = ["--foreground", "--background", "--primary", "--accent"] as const

export type BootMirrorKey = (typeof BOOT_MIRROR_KEYS)[number]

export const BOOT_MIRROR_STORAGE_KEY = "cognia.appearance.mirror"

/**
 * Routes rendered inside a transparent desktop-pet window (the sprite and its
 * click popup). The boot script marks `<html data-pet-overlay>` on them before
 * the first paint, so the page is transparent even when no React ever runs:
 * the native safety net force-reveals a sprite window whose renderer never
 * signalled its first frame, and the views set the same attribute only from
 * an effect, after hydration — without this that reveal showed an opaque box.
 */
export const PET_OVERLAY_ROUTE_PATTERN = /^\/pet-(?:overlay|popup)(?:\/|$)/

/**
 * Mirror payload. The four flat color keys are the original FOUC-critical
 * shell colors (kept flat for backward compatibility). The nested `vars` /
 * `attrs` extend anti-flicker coverage to the other `<html>`-level knobs the
 * appliers own — radius, typography (font families + line-height + letter
 * spacing), and density — so a cold boot no longer flashes default spacing /
 * corner radius / font before hydration. Wallpaper is intentionally NOT
 * mirrored: it is applied to `<body>`, which does not exist yet when this
 * head-injected script runs, and its image data-URLs can be multi-megabyte.
 */
export type BootMirrorPayload = Partial<Record<BootMirrorKey, string>> & {
  /** Resolved variant that produced the cached colors. Legacy colors are ignored. */
  colorScheme?: "light" | "dark"
  /**
   * The rest of the resolved color palette (`--card`, `--muted`, `--input`,
   * `--border`, …), keyed by CSS custom property. Guarded by `colorScheme`
   * exactly like the four flat keys, because these are per-variant values.
   *
   * The four flat keys were enough for a first-paint flash, but not for the
   * surfaces that render BEFORE `CustomThemeApplier` mounts: the lock screen
   * and the other account-gate screens sit outside the authenticated tree, so
   * with only those four they painted a custom theme's background under the
   * default palette's inputs, borders and muted text.
   */
  palette?: Record<string, string>
  /** Extra CSS custom properties (`--*`) to set on `<html>`. */
  vars?: Record<string, string>
  /** data-* attributes to set on `<html>` (e.g. `data-density`). */
  attrs?: Record<string, string>
}

/**
 * The boot routine, expressed as a real TypeScript function so unit tests
 * can call it directly — no `new Function()` / `eval` dance, no lint
 * suppression. The serialised string form below is what `app/layout.tsx`
 * embeds in a `<Script>` tag.
 *
 * Implementation deliberately avoids module imports and modern syntax that
 * older WebViews choke on; it runs before bundling has executed.
 */
export function runBootScript(): void {
  try {
    if (PET_OVERLAY_ROUTE_PATTERN.test(window.location.pathname)) {
      document.documentElement.setAttribute("data-pet-overlay", "1")
    }
    const raw = window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)
    if (!raw) return
    const mirror = JSON.parse(raw) as Record<string, unknown> | null
    if (!mirror || typeof mirror !== "object") return
    const root = document.documentElement
    // next-themes has already resolved the class before this queued script runs.
    // A system-theme change between launches must not replay the old palette.
    const colorScheme = root.classList.contains("dark") ? "dark" : "light"
    const schemeMatches = mirror.colorScheme === colorScheme
    const colorKeys = schemeMatches ? BOOT_MIRROR_KEYS : []
    for (const key of colorKeys) {
      const value = mirror[key]
      if (typeof value === "string" && value.length > 0) {
        root.style.setProperty(key, value)
      }
    }
    // Full palette, under the same variant guard as the flat keys above.
    const palette = schemeMatches ? mirror.palette : null
    if (palette && typeof palette === "object") {
      for (const name of Object.keys(palette as Record<string, unknown>)) {
        const value = (palette as Record<string, unknown>)[name]
        if (name.indexOf("--") === 0 && typeof value === "string" && value.length > 0) {
          root.style.setProperty(name, value)
        }
      }
    }
    // Extended vars (radius / typography). Guard to `--*` names so a corrupt
    // mirror can't set arbitrary inline styles.
    const vars = mirror.vars
    if (vars && typeof vars === "object") {
      for (const name of Object.keys(vars as Record<string, unknown>)) {
        const value = (vars as Record<string, unknown>)[name]
        if (name.indexOf("--") === 0 && typeof value === "string" && value.length > 0) {
          root.style.setProperty(name, value)
        }
      }
    }
    // Extended attrs (density). Guard to `data-*` names.
    const attrs = mirror.attrs
    if (attrs && typeof attrs === "object") {
      for (const name of Object.keys(attrs as Record<string, unknown>)) {
        const value = (attrs as Record<string, unknown>)[name]
        if (name.indexOf("data-") === 0 && typeof value === "string" && value.length > 0) {
          root.setAttribute(name, value)
        }
      }
    }
  } catch {
    // Silently swallow — a corrupt mirror must never break first paint.
  }
}

/**
 * Serialised IIFE that runs `runBootScript`. Embedded into `<head>` via
 * `<Script strategy="beforeInteractive" dangerouslySetInnerHTML>`. We
 * inline the key constants so the script has no external references at
 * boot time — module resolution doesn't exist yet.
 */
export const BOOT_SCRIPT = [
  "(function () {",
  "  try {",
  `    if (${PET_OVERLAY_ROUTE_PATTERN.toString()}.test(window.location.pathname)) {`,
  "      document.documentElement.setAttribute('data-pet-overlay', '1');",
  "    }",
  `    var raw = window.localStorage.getItem(${JSON.stringify(BOOT_MIRROR_STORAGE_KEY)});`,
  "    if (!raw) return;",
  "    var mirror = JSON.parse(raw);",
  "    if (!mirror || typeof mirror !== 'object') return;",
  "    var root = document.documentElement;",
  '    var colorScheme = root.classList.contains("dark") ? "dark" : "light";',
  "    var schemeMatches = mirror.colorScheme === colorScheme;",
  `    var keys = schemeMatches ? ${JSON.stringify(BOOT_MIRROR_KEYS)} : [];`,
  "    for (var i = 0; i < keys.length; i++) {",
  "      var key = keys[i];",
  "      var value = mirror[key];",
  "      if (typeof value === 'string' && value.length > 0) {",
  "        root.style.setProperty(key, value);",
  "      }",
  "    }",
  "    var palette = schemeMatches ? mirror.palette : null;",
  "    if (palette && typeof palette === 'object') {",
  "      var pkeys = Object.keys(palette);",
  "      for (var p = 0; p < pkeys.length; p++) {",
  "        var pn = pkeys[p];",
  "        var pv = palette[pn];",
  "        if (pn.indexOf('--') === 0 && typeof pv === 'string' && pv.length > 0) {",
  "          root.style.setProperty(pn, pv);",
  "        }",
  "      }",
  "    }",
  "    var vars = mirror.vars;",
  "    if (vars && typeof vars === 'object') {",
  "      var vkeys = Object.keys(vars);",
  "      for (var v = 0; v < vkeys.length; v++) {",
  "        var vn = vkeys[v];",
  "        var vv = vars[vn];",
  "        if (vn.indexOf('--') === 0 && typeof vv === 'string' && vv.length > 0) {",
  "          root.style.setProperty(vn, vv);",
  "        }",
  "      }",
  "    }",
  "    var attrs = mirror.attrs;",
  "    if (attrs && typeof attrs === 'object') {",
  "      var akeys = Object.keys(attrs);",
  "      for (var a = 0; a < akeys.length; a++) {",
  "        var an = akeys[a];",
  "        var av = attrs[an];",
  "        if (an.indexOf('data-') === 0 && typeof av === 'string' && av.length > 0) {",
  "          root.setAttribute(an, av);",
  "        }",
  "      }",
  "    }",
  "  } catch (err) {",
  "    /* swallow */",
  "  }",
  "})();",
].join("\n")

/**
 * Persist the current appearance snapshot to localStorage. Callers should
 * hand in the resolved hex values from `getShellColors` + the resolved
 * preset palette so the mirror reflects exactly what the active appliers
 * paint.
 */
export function writeBootMirror(payload: BootMirrorPayload): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(BOOT_MIRROR_STORAGE_KEY, JSON.stringify(payload))
  } catch (err) {
    // localStorage can throw (quota, private-mode iOS). Best-effort only.
    console.warn("writeBootMirror failed", err)
  }
}

/**
 * Clear the persisted mirror. Used by `SettingsHydrator` when the active theme
 * is the default preset (which globals.css governs, so there is nothing to
 * pre-paint) and by tests.
 */
export function clearBootMirror(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(BOOT_MIRROR_STORAGE_KEY)
  } catch {
    /* swallow */
  }
}
