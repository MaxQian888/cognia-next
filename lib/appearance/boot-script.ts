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
    const raw = window.localStorage.getItem(BOOT_MIRROR_STORAGE_KEY)
    if (!raw) return
    const mirror = JSON.parse(raw) as Record<string, unknown> | null
    if (!mirror || typeof mirror !== "object") return
    const root = document.documentElement
    for (const key of BOOT_MIRROR_KEYS) {
      const value = mirror[key]
      if (typeof value === "string" && value.length > 0) {
        root.style.setProperty(key, value)
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
  `    var raw = window.localStorage.getItem(${JSON.stringify(BOOT_MIRROR_STORAGE_KEY)});`,
  "    if (!raw) return;",
  "    var mirror = JSON.parse(raw);",
  "    if (!mirror || typeof mirror !== 'object') return;",
  "    var root = document.documentElement;",
  `    var keys = ${JSON.stringify(BOOT_MIRROR_KEYS)};`,
  "    for (var i = 0; i < keys.length; i++) {",
  "      var key = keys[i];",
  "      var value = mirror[key];",
  "      if (typeof value === 'string' && value.length > 0) {",
  "        root.style.setProperty(key, value);",
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
