"use client"

/**
 * `<FileTypeIcon>` — the glyph shown next to a file path anywhere in the app.
 *
 * Two sources, in priority order:
 *
 *  1. A VS Code icon theme contributed by an enabled plugin
 *     (`contributes.iconThemes[]` / `manifest.vscodeIconThemes`). It is
 *     preferred because someone who deliberately enabled Material Icon Theme
 *     wants *those* icons, not our approximation of them. A bundled built-in
 *     (the `cognia-material-icon-theme` plugin, `builtin://` root) resolves on
 *     every shell through its `/plugins/<id>/` public mirror; an installed
 *     third-party theme is files on disk, so it only resolves on the desktop
 *     shell through Tauri's asset protocol.
 *  2. Otherwise a built-in glyph derived from `lib/files/file-type-icon.ts`.
 *     This is what everyone gets by default (the Material built-in ships
 *     disabled), so a `.tsx`, a `.png` and a lockfile are distinguishable
 *     without enabling anything.
 *
 * The icon is decorative: it always sits beside the filename, which is the
 * accessible name, so it is `aria-hidden` and contributes no translated string.
 */

import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import {
  BinaryIcon,
  BookTextIcon,
  BracesIcon,
  ContainerIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileCogIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileLockIcon,
  FileSpreadsheetIcon,
  FileTerminalIcon,
  FileTextIcon,
  FileTypeIcon as FileTypeGlyphIcon,
  FileVideoIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  PackageIcon,
  PaletteIcon,
  PresentationIcon,
  ScrollTextIcon,
  type LucideIcon,
} from "lucide-react"

import {
  getActiveIconTheme,
  type IconThemeColorScheme,
  resolveFileIcon,
  subscribeIconThemes,
} from "@/lib/plugin/bridge/icons-bridge"
import {
  isIconThemeHighContrast,
  subscribeIconThemeHighContrast,
} from "@/lib/plugin/bridge/icon-theme-high-contrast"
import { joinPluginPath, publicBuiltinAssetUrl } from "@/lib/plugin/bridge/plugin-file-path"
import { resolveFileTypeIcon, type FileTypeIconKind } from "@/lib/files/file-type-icon"
import { cn } from "@/lib/utils"

/**
 * Kind → glyph. Exhaustive by construction: `Record<FileTypeIconKind, …>` makes
 * a new kind without a glyph a type error rather than a silently generic icon.
 *
 * Several kinds share a glyph on purpose — lucide has no per-language marks, so
 * the *colour* carries the language and the glyph carries the category. That is
 * also why `code` and the language kinds all resolve to a code glyph: a wall of
 * near-identical bespoke shapes would be harder to scan, not easier.
 */
const GLYPHS: Record<FileTypeIconKind, LucideIcon> = {
  folder: FolderIcon,
  code: FileCodeIcon,
  javascript: FileCodeIcon,
  typescript: FileCodeIcon,
  react: FileCodeIcon,
  vue: FileCodeIcon,
  svelte: FileCodeIcon,
  python: FileCodeIcon,
  rust: FileCodeIcon,
  go: FileCodeIcon,
  java: FileCodeIcon,
  ruby: FileCodeIcon,
  php: FileCodeIcon,
  shell: FileTerminalIcon,
  json: FileJsonIcon,
  yaml: BracesIcon,
  toml: BracesIcon,
  xml: FileCodeIcon,
  html: GlobeIcon,
  css: PaletteIcon,
  markdown: BookTextIcon,
  text: FileTextIcon,
  pdf: ScrollTextIcon,
  document: FileTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  presentation: PresentationIcon,
  image: FileImageIcon,
  video: FileVideoIcon,
  audio: FileAudioIcon,
  font: FileTypeGlyphIcon,
  archive: FileArchiveIcon,
  database: DatabaseIcon,
  lock: FileLockIcon,
  key: KeyRoundIcon,
  config: FileCogIcon,
  git: GitBranchIcon,
  docker: ContainerIcon,
  package: PackageIcon,
  binary: BinaryIcon,
  notebook: FileCodeIcon,
  file: FileIcon,
}

export interface FileTypeIconProps {
  /** Path or bare filename. Only the basename is classified. */
  path: string
  /**
   * Whether this entry is a directory. Passed, never inferred: a directory named
   * `styles.css` is a directory, and guessing from the name is how a folder ends
   * up wearing a stylesheet icon.
   */
  isDir?: boolean
  /** Sizing / spacing from the host row. Defaults to the 14px chip size. */
  className?: string
  /**
   * Drop the per-type colour and inherit the surrounding ink. For rows that
   * already carry their own state colour (a deleted file, a disabled chip),
   * where a second colour would compete rather than inform.
   */
  muted?: boolean
}

/** Re-render every consumer when a plugin adds or removes an icon theme. */
let iconThemeVersion = 0
subscribeIconThemes(() => {
  iconThemeVersion += 1
})
function subscribeIconThemeVersion(onStoreChange: () => void): () => void {
  return subscribeIconThemes(() => onStoreChange())
}

/**
 * Collapse `.`/`..` segments inside a theme-relative path, rejecting any
 * result that escapes the plugin root. Real icon themes (Material Icon
 * Theme ships `dist/theme.json` + `icons/*.svg`) reference icons as
 * `../icons/x.svg` relative to the theme JSON's directory — `joinPluginPath`
 * hard-rejects `..` segments, so the containment check must happen on the
 * already-collapsed path, not the raw contribution value.
 */
function collapseThemeRelativePath(path: string): string | null {
  const out: string[] = []
  for (const seg of path.split(/[\\/]+/)) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (!out.pop()) return null
    } else {
      out.push(seg)
    }
  }
  return out.length > 0 ? out.join("/") : null
}

/**
 * Resolved location of the themed icon for this entry, or null when no
 * theme is active / it has no icon for this file. The result is either an
 * absolute on-disk path (third-party plugin — displayable through Tauri's
 * asset protocol) or a `builtin://` URI (bundled plugin — displayable
 * through the `/plugins/<id>/` public mirror on every shell).
 */
function themedIconPath(path: string, isDir: boolean, scheme: IconThemeColorScheme): string | null {
  const theme = getActiveIconTheme()
  if (!theme?.baseDir) return null
  // The bridge resolves files; folders keep the built-in glyph so the two
  // sources cannot disagree about which folder state is being shown.
  if (isDir) return null
  const def = resolveFileIcon(theme.id, path.split(/[\\/]/).pop() ?? path, undefined, scheme)
  if (!def?.iconPath) return null
  // `iconPath` is relative to the theme JSON's own directory.
  const dir = theme.jsonPath.includes("/")
    ? theme.jsonPath.slice(0, theme.jsonPath.lastIndexOf("/"))
    : ""
  const rel = collapseThemeRelativePath(dir ? `${dir}/${def.iconPath}` : def.iconPath)
  if (!rel) return null
  return joinPluginPath(theme.baseDir, rel)
}

/**
 * `builtin://<pluginId>/<relative>` → `/plugins/<pluginId>/<relative>` —
 * the same public mirror `readContainedPluginAsset` uses for bundled plugin
 * assets off-desktop.
 */
function builtinThemeIconUrl(uri: string): string | null {
  const rest = uri.slice("builtin://".length)
  const slash = rest.indexOf("/")
  if (slash <= 0 || slash === rest.length - 1) return null
  return publicBuiltinAssetUrl(rest.slice(0, slash), rest.slice(slash + 1))
}

/** Tauri asset-protocol URL for an absolute path; null off-desktop. */
export function toDisplayableFileSrc(absPath: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { convertFileSrc } = require("@tauri-apps/api/core") as {
      convertFileSrc?: (p: string) => string
    }
    return convertFileSrc ? convertFileSrc(absPath) : null
  } catch {
    return null
  }
}

export function FileTypeIcon({ path, isDir = false, className, muted }: FileTypeIconProps) {
  // Subscribed, not read once: a plugin enabled AFTER this rendered must repaint
  // its icons. Reading the registry during render without subscribing is the
  // classic "registered but never appears" bug.
  useSyncExternalStore(
    subscribeIconThemeVersion,
    () => iconThemeVersion,
    () => iconThemeVersion
  )
  // Which association set of the theme applies, the way VS Code layers them:
  // the high-contrast overrides while an a11y high-contrast palette is forced,
  // the `light` overrides under a light theme (Material re-colours ~200 icons
  // there that would be illegible on white), the base set otherwise.
  // High contrast is what the theme applier actually painted, published for
  // icons — not the raw setting, which a plugin colour theme overrides.
  const { resolvedTheme } = useTheme()
  const highContrast = useSyncExternalStore(
    subscribeIconThemeHighContrast,
    isIconThemeHighContrast,
    () => false
  )
  const scheme: IconThemeColorScheme = highContrast
    ? "highContrast"
    : resolvedTheme === "light"
      ? "light"
      : "dark"

  // The default size is MERGED, not replaced: `className` is documented as
  // "sizing / spacing from the host row", so a caller passing only spacing
  // (`mr-2`) or a colour override still gets the 14px chip. tailwind-merge
  // drops the default whenever `className` carries its own `size-*`.
  const base = cn("shrink-0 size-3.5", className)
  const themed = themedIconPath(path, isDir, scheme)
  if (themed) {
    const src = themed.startsWith("builtin://")
      ? builtinThemeIconUrl(themed)
      : toDisplayableFileSrc(themed)
    if (src) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={src} alt="" aria-hidden className={base} />
    }
  }

  const { kind, tone } = resolveFileTypeIcon(path, isDir)
  const Glyph = GLYPHS[kind]
  return (
    <Glyph
      aria-hidden
      data-file-type={kind}
      className={cn("shrink-0 size-3.5", muted ? "text-muted-foreground" : tone, className)}
    />
  )
}
