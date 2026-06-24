"use client"

/**
 * One mounted xterm.js Terminal bound to one live `TerminalSession`.
 *
 * Lifecycle:
 *   * On mount: lazy-import `@xterm/xterm` + addons, construct a Terminal,
 *     open it in our container div, wire data + input flow.
 *   * On `sessionId` change: tear down the old Terminal, create a fresh one.
 *   * On unmount: dispose Terminal + drop backpressure listener.
 *
 * Backpressure model — `lib/terminal/backpressure.ts`:
 *   * PTY bytes arrive via `session.onData(uint8)` → we forward to
 *     `bp.push(uint8)`. The coalescer batches per rAF and calls
 *     `term.write(merged, ack)`. xterm's ack callback drives the
 *     watermark accounting; high-watermark triggers `term.refresh` to
 *     ensure repaint, low-watermark resumes new pushes (the Rust side
 *     doesn't currently observe pause/resume — placeholder for a
 *     future XON/XOFF sentinel; v1 relies on Channel queue depth).
 *
 * User input flow:
 *   * `term.onData(text)` → `session.write(text)` over Tauri IPC.
 *
 * Resize:
 *   * `ResizeObserver` on the container → `FitAddon.fit()` → grabs new
 *     rows/cols and calls `session.resize(rows, cols)`.
 *
 * Renderer: `WebglAddon` with a `CanvasAddon` fallback. WebGL fails to
 * activate when the GPU process refuses (some Linux setups, headless
 * CI); the fallback keeps the terminal usable.
 *
 * Clipboard (Wave 3A):
 *   * Ctrl/Cmd+Shift+C → copy selection via `navigator.clipboard.writeText`.
 *   * Ctrl/Cmd+Shift+V → paste via `term.paste` (selectiveText only).
 *   * `term.onSelectionChange` → opt-in selection-copy when the user
 *     enables it in settings (default off so accidental selection
 *     doesn't overwrite the clipboard).
 *
 * Live settings:
 *   * Subscribes to `useSettingsStore` for fontFamily/fontSize/scrollback;
 *     mutates `term.options.*` in place when they change, so an open tab
 *     reflects setting tweaks without a full remount.
 *   * Tracks `<html class="dark">` via `MutationObserver` and switches
 *     the xterm theme accordingly.
 *
 * Search (Wave 3A):
 *   * `@xterm/addon-search` is lazy-loaded; the imperative handle exposes
 *     `findNext` / `findPrevious` / `clearSearch` for the dock's
 *     `TerminalSearchOverlay` to drive.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardedRef,
} from "react"
import { useTranslations } from "next-intl"

import type { IDecoration, ILink, ILinkProvider, IMarker } from "@xterm/xterm"
// xterm.js ships its own stylesheet that positions the viewport, screen, and the
// stacked renderer canvases (`position: absolute`). Without it every row/cell
// collapses into the top-left corner. Same side-effect-import pattern the
// workflow canvas uses for `@xyflow/react/dist/style.css`.
import "@xterm/xterm/css/xterm.css"

import { TerminalBackpressure } from "@/lib/terminal/backpressure"
import { findColorScheme, resolveTerminalTheme } from "@/lib/terminal/color-schemes"
import type { TerminalTheme } from "@/lib/terminal/color-schemes"
import { exitMarkerColor, nextMarkerLine, prevMarkerLine } from "@/lib/terminal/command-markers"
import { getLiveSession } from "@/lib/terminal/session-registry"
import { matchFileLinks, resolveLinkPath } from "@/lib/terminal/terminal-links"
import type { IntegrationEvent } from "@/lib/terminal/types"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalAutocomplete } from "@/hooks/terminal/use-terminal-autocomplete"
import { TerminalCompletionPopup } from "@/components/terminal/terminal-completion-popup"
import { TerminalGhostText } from "@/components/terminal/terminal-ghost-text"

/**
 * DEL (0x7f) — what xterm emits for Backspace and what readline/PSReadLine
 * interpret as delete-back. Used to erase a replaced span when accepting a
 * token-replacement completion.
 */
const DEL_BYTE = String.fromCharCode(0x7f)

export interface TerminalInstanceProps {
  sessionId: string
  /** Override the settings-store fontFamily (mobile screens may want a smaller default). */
  fontFamily?: string
  /** Override the settings-store fontSize. */
  fontSize?: number
  /** Override the settings-store scrollback. */
  scrollback?: number
  /**
   * When true, every selection change is auto-copied to the clipboard.
   * Defaults to false; the user toggles via settings.
   */
  copyOnSelect?: boolean
}

/** Imperative actions the dock / overlay can drive on the active instance. */
export interface TerminalInstanceHandle {
  findNext: (pattern: string, caseSensitive?: boolean) => boolean
  findPrevious: (pattern: string, caseSensitive?: boolean) => boolean
  clearSearch: () => void
  /** Force a clear-screen (Ctrl+L equivalent) via xterm's API. */
  clearScreen: () => void
  /** Trigger a copy of the current selection (or no-op if none). */
  copySelection: () => Promise<void>
  /** Trigger a paste from the system clipboard (or no-op if unavailable). */
  pasteFromClipboard: () => Promise<void>
  /** Select the entire terminal buffer. */
  selectAll: () => void
  /** Reset any keyboard zoom back to the configured font size. */
  resetZoom: () => void
  /** Scroll to the previous OSC 633 command boundary (no-op when none above). */
  jumpToPrevCommand: () => void
  /** Scroll to the next OSC 633 command boundary (no-op when none below). */
  jumpToNextCommand: () => void
}

interface CommandMarkerEntry {
  marker: IMarker
  decoration: IDecoration | undefined
  exitCode: number | null
}

/** Paint a gutter bar for a command marker, coloured by exit state. */
function paintMarkerDecoration(decoration: IDecoration | undefined, exitCode: number | null) {
  if (!decoration || typeof decoration.onRender !== "function") return
  const color = exitMarkerColor(exitCode)
  decoration.onRender((el) => {
    // xterm already positions the element at the command's start row and
    // sizes it to a single cell-row (inline `top` + `height`). Only restyle
    // the cosmetics here. Do NOT set `height: 100%`: that stretches every
    // marker from its row to the bottom of the viewport, so with `left: 0`
    // they stack and overlap into one solid bar down the left edge instead
    // of a per-command gutter tick.
    el.style.left = "0"
    el.style.width = "3px"
    el.style.backgroundColor = color
    el.style.pointerEvents = "none"
  })
}

/** Minimal xterm surface used to scroll between command markers. */
interface XtermScrollable {
  scrollToLine?: (line: number) => void
  buffer?: { active?: { viewportY?: number } }
}

/** Scroll the terminal to the prev/next command marker relative to the viewport top. */
function jumpToCommand(
  term: XtermScrollable | null,
  markers: CommandMarkerEntry[],
  dir: "prev" | "next"
): void {
  if (!term || typeof term.scrollToLine !== "function") return
  const lines = markers.map((m) => m.marker.line).filter((n) => Number.isFinite(n))
  if (lines.length === 0) return
  const ref = term.buffer?.active?.viewportY ?? 0
  const target = dir === "prev" ? prevMarkerLine(lines, ref) : nextMarkerLine(lines, ref)
  if (target != null) term.scrollToLine(target)
}

/**
 * Pixel position of the xterm cursor relative to the terminal container,
 * for anchoring the autocomplete ghost text. Reads xterm's render-service
 * cell dimensions (guarded — the field is internal and may be absent in
 * the DOM renderer / before first paint). Returns null when it can't be
 * resolved, so the overlay simply isn't shown.
 */
function cursorPixelPosition(term: unknown): { left: number; top: number } | null {
  try {
    const t = term as {
      buffer?: { active?: { cursorX?: number; cursorY?: number } }
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } }
      }
    }
    const cell = t._core?._renderService?.dimensions?.css?.cell
    const cw = cell?.width
    const ch = cell?.height
    if (!cw || !ch) return null
    const x = t.buffer?.active?.cursorX ?? 0
    const y = t.buffer?.active?.cursorY ?? 0
    return { left: Math.round(x * cw), top: Math.round(y * ch) }
  } catch {
    return null
  }
}

const DEFAULT_FONT_FAMILY = '"JetBrains Mono", "Cascadia Code", "Menlo", "Consolas", monospace'
const DEFAULT_FONT_SIZE = 13
const DEFAULT_SCROLLBACK = 10000
const MIN_ZOOM_FONT_SIZE = 6
const MAX_ZOOM_FONT_SIZE = 40

/** Clamp a (possibly zoomed) font size to a sane rendering range. */
function clampFontSize(size: number): number {
  return Math.max(MIN_ZOOM_FONT_SIZE, Math.min(MAX_ZOOM_FONT_SIZE, size))
}

/**
 * xterm.js theme for the active color scheme. Delegates to the shared
 * `resolveTerminalTheme` so the full ANSI 16-color palette and the named
 * scheme presets live in one place. `"auto"` (default) follows the app's
 * light/dark mode; named schemes are fixed.
 */
/**
 * Resolve the app's `--background` / `--foreground` design tokens to concrete
 * `rgb(...)` strings (which xterm parses) by probing computed style. Returns
 * null outside the browser (SSR / jsdom) or when the vars don't resolve, so
 * callers fall back to the static palette. This is what keeps the `"auto"`
 * scheme matching the surrounding `bg-background` chrome under any theme —
 * including user custom themes that retune the oklch tokens in `globals.css`.
 */
function readAppAutoTokens(): Pick<TerminalTheme, "background" | "foreground" | "cursor"> | null {
  if (typeof document === "undefined" || !document.body) return null
  const resolveVar = (varName: string): string | null => {
    const probe = document.createElement("span")
    probe.style.color = `var(${varName})`
    probe.style.display = "none"
    document.body.appendChild(probe)
    const rgb = getComputedStyle(probe).color
    probe.remove()
    return rgb && rgb.startsWith("rgb") ? rgb : null
  }
  const background = resolveVar("--background")
  const foreground = resolveVar("--foreground")
  if (!background || !foreground) return null
  return { background, foreground, cursor: foreground }
}

function makeTheme(isDark: boolean, schemeId?: string) {
  // Match the app's neutral palette (oklch in `globals.css`) for the base
  // tokens, and supply a full ANSI 16-color palette so colored output
  // (oh-my-posh, starship, `ls --color`, git) renders with intentional,
  // legible colors instead of xterm's washed-out defaults. The dark palette
  // is Windows Terminal's "Campbell" — the canonical PowerShell scheme — so
  // PowerShell prompts look exactly as the user expects.
  const base = resolveTerminalTheme(schemeId, isDark)
  // Named schemes are intentionally fixed palettes; only `"auto"` follows the
  // app. For it, override the base/foreground/cursor with the live CSS tokens
  // so the terminal surface stays consistent with the rest of the UI.
  if (findColorScheme(schemeId)) return base
  const tokens = readAppAutoTokens()
  return tokens ? { ...base, ...tokens } : base
}

function isHtmlDark(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.classList.contains("dark")
}

function TerminalInstanceImpl(
  {
    sessionId,
    fontFamily: fontFamilyProp,
    fontSize: fontSizeProp,
    scrollback: scrollbackProp,
    copyOnSelect: copyOnSelectProp,
  }: TerminalInstanceProps,
  ref: ForwardedRef<TerminalInstanceHandle>
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const disposedRef = useRef(false)
  // The active xterm + its addons live in a ref so the live-settings
  // effect can mutate options without re-running the setup effect.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const searchAddonRef = useRef<any | null>(null)
  // OSC 633 command markers (1B) — newest last. Each holds the xterm
  // marker, its current gutter decoration, and the captured exit code.
  const markersRef = useRef<CommandMarkerEntry[]>([])
  // Active color-scheme id, mirrored into a ref so the `.dark` MutationObserver
  // (which only re-runs on app theme flips) always reads the current scheme
  // without re-running the setup effect.
  const colorSchemeRef = useRef<string>("auto")
  // Ephemeral per-instance font zoom (Ctrl+= / Ctrl+- / Ctrl+0). Stored as a
  // delta on top of the configured font size so it survives setting changes
  // and never mutates global settings. `applyZoomRef` is wired during setup so
  // the imperative `resetZoom` can re-apply from outside the effect closure.
  const zoomRef = useRef<number>(0)
  const fontSizeRef = useRef<number>(DEFAULT_FONT_SIZE)
  const applyZoomRef = useRef<(() => void) | null>(null)
  // Re-fit the live xterm to the container and propagate the new cols/rows to
  // the PTY. Wired during setup so the live-settings effect can re-fit after a
  // font change (a different cell size means the old cols/rows no longer match
  // the container) from outside the setup-effect closure.
  const refitRef = useRef<(() => void) | null>(null)

  // Settings-store derived defaults. Component props override; this lets
  // the mobile screen pin a fontSize while desktop follows user settings.
  const settingsFontFamily = useSettingsStore(
    (s) => (s.settings?.terminal as { fontFamily?: string } | undefined)?.fontFamily
  )
  const settingsFontSize = useSettingsStore(
    (s) => (s.settings?.terminal as { fontSize?: number } | undefined)?.fontSize
  )
  const settingsScrollback = useSettingsStore(
    (s) => (s.settings?.terminal as { scrollback?: number } | undefined)?.scrollback
  )
  const settingsCopyOnSelect = useSettingsStore(
    (s) => (s.settings?.terminal as { copyOnSelect?: boolean } | undefined)?.copyOnSelect ?? false
  )
  const cursorStyle = useSettingsStore(
    (s) =>
      (s.settings?.terminal as { cursorStyle?: "block" | "bar" | "underline" } | undefined)
        ?.cursorStyle ?? "block"
  )
  const cursorBlink = useSettingsStore(
    (s) => (s.settings?.terminal as { cursorBlink?: boolean } | undefined)?.cursorBlink ?? true
  )
  const fontLigatures = useSettingsStore(
    (s) => (s.settings?.terminal as { fontLigatures?: boolean } | undefined)?.fontLigatures ?? false
  )
  const colorScheme = useSettingsStore(
    (s) => (s.settings?.terminal as { colorScheme?: string } | undefined)?.colorScheme ?? "auto"
  )
  const renderer = useSettingsStore(
    (s) =>
      (s.settings?.terminal as { renderer?: "auto" | "webgl" | "canvas" | "dom" } | undefined)
        ?.renderer ?? "auto"
  )

  const fontFamily =
    fontFamilyProp ??
    (settingsFontFamily && settingsFontFamily.length > 0 ? settingsFontFamily : DEFAULT_FONT_FAMILY)
  const fontSize =
    fontSizeProp ?? (typeof settingsFontSize === "number" ? settingsFontSize : DEFAULT_FONT_SIZE)
  const scrollback =
    scrollbackProp ??
    (typeof settingsScrollback === "number" ? settingsScrollback : DEFAULT_SCROLLBACK)
  const copyOnSelect = copyOnSelectProp ?? settingsCopyOnSelect

  const t = useTranslations("terminal")

  // Copilot-style inline autocomplete (ADR-0039). The hook owns the
  // debounce / provider fan-out / line model; we feed it keystrokes, render
  // its ghost suffix, and intercept Tab/→/Esc below. `acRef` lets the
  // setup-effect closures (onData / key handler / integration) read the
  // latest API without re-running setup.
  const autocomplete = useTerminalAutocomplete(sessionId)
  const acRef = useRef(autocomplete)
  useEffect(() => {
    acRef.current = autocomplete
  })
  const [ghostPos, setGhostPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  // Re-anchor the ghost text / popup to the cursor whenever the suffix or
  // popup state changes (covers both keystroke-driven and async-resolved
  // suggestions).
  useEffect(() => {
    if (!autocomplete.ghost && !autocomplete.listOpen) return
    const pos = cursorPixelPosition(termRef.current)
    if (pos) setGhostPos(pos)
  }, [autocomplete.ghost, autocomplete.listOpen, autocomplete.candidates])

  // Imperative API for the search overlay + context-menu actions.
  useImperativeHandle(
    ref,
    () => ({
      findNext: (pattern, caseSensitive) => {
        const search = searchAddonRef.current
        if (!search || typeof search.findNext !== "function") return false
        try {
          return !!search.findNext(pattern, { caseSensitive: !!caseSensitive })
        } catch {
          return false
        }
      },
      findPrevious: (pattern, caseSensitive) => {
        const search = searchAddonRef.current
        if (!search || typeof search.findPrevious !== "function") return false
        try {
          return !!search.findPrevious(pattern, { caseSensitive: !!caseSensitive })
        } catch {
          return false
        }
      },
      clearSearch: () => {
        try {
          searchAddonRef.current?.clearDecorations?.()
        } catch {
          /* noop */
        }
      },
      clearScreen: () => {
        try {
          termRef.current?.clear()
        } catch {
          /* noop */
        }
      },
      copySelection: async () => {
        const term = termRef.current
        if (!term) return
        try {
          const sel = term.getSelection()
          if (sel && navigator.clipboard) {
            await navigator.clipboard.writeText(sel)
          }
        } catch {
          /* noop */
        }
      },
      pasteFromClipboard: async () => {
        const term = termRef.current
        if (!term || !navigator.clipboard) return
        try {
          const text = await navigator.clipboard.readText()
          if (text) term.paste(text)
        } catch {
          /* noop — Safari without permission, headless test env */
        }
      },
      selectAll: () => {
        try {
          termRef.current?.selectAll?.()
        } catch {
          /* noop */
        }
      },
      resetZoom: () => {
        zoomRef.current = 0
        try {
          applyZoomRef.current?.()
        } catch {
          /* noop */
        }
      },
      jumpToPrevCommand: () => jumpToCommand(termRef.current, markersRef.current, "prev"),
      jumpToNextCommand: () => jumpToCommand(termRef.current, markersRef.current, "next"),
    }),
    []
  )

  useEffect(() => {
    disposedRef.current = false
    const container = containerRef.current
    if (!container) return
    const session = getLiveSession(sessionId)
    if (!session) {
      // Race against the session being unregistered. The dock filters
      // out exited sessions before mounting, but defensive.
      return
    }

    let cleanup: () => void = () => {}

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { Unicode11Addon }, { SearchAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
          import("@xterm/addon-unicode11"),
          import("@xterm/addon-search"),
        ])
      // Renderer addons load conditionally so a missing WebGL context
      // doesn't crash the dock.
      let webglCtor: typeof import("@xterm/addon-webgl").WebglAddon | null = null
      let canvasCtor: typeof import("@xterm/addon-canvas").CanvasAddon | null = null
      try {
        webglCtor = (await import("@xterm/addon-webgl")).WebglAddon
      } catch {
        // ignore — fall through to canvas fallback below
      }
      try {
        canvasCtor = (await import("@xterm/addon-canvas")).CanvasAddon
      } catch {
        // ignore — DOM renderer is always available as the last fallback
      }

      if (disposedRef.current) return

      colorSchemeRef.current = colorScheme
      const term = new Terminal({
        cursorBlink,
        cursorStyle,
        fontFamily,
        fontSize,
        scrollback,
        allowProposedApi: true,
        theme: makeTheme(isHtmlDark(), colorScheme),
      })
      termRef.current = term

      const fit = new FitAddon()
      term.loadAddon(fit)
      // Plain-text URL detection (regex-based). Handles `https://…` and `www.…`
      // sequences that the shell emits without any escape codes.
      term.loadAddon(new WebLinksAddon())
      // Wave 4 — OSC 8 explicit hyperlinks (`\e]8;;<url>\e\<text>\e]8;;\e\`).
      // xterm.js 5.x ships an OSC 8 parser that surfaces the URL via the
      // `linkHandler` API; we register a handler that opens the URL in the
      // default browser (Tauri's openExternal protocol when present, or
      // window.open as a fallback). Without this hook, OSC 8 sequences
      // would underline the text but clicks would be no-ops.
      term.options.linkHandler = {
        activate: (_event: MouseEvent, uri: string) => {
          openExternalLink(uri)
        },
        hover: () => undefined,
        leave: () => undefined,
      }
      const uni = new Unicode11Addon()
      term.loadAddon(uni)
      term.unicode.activeVersion = "11"
      const search = new SearchAddon()
      term.loadAddon(search)
      searchAddonRef.current = search

      // Apply the configured font size plus the active zoom delta, then re-fit
      // so the PTY's cols/rows track the new cell size. Wired into a ref so the
      // imperative `resetZoom` can call it from outside this effect.
      const applyZoom = () => {
        try {
          term.options.fontSize = clampFontSize(fontSizeRef.current + zoomRef.current)
          refitRef.current?.()
        } catch {
          /* noop — container may not be laid out */
        }
      }
      applyZoomRef.current = applyZoom

      // Keyboard handlers: Ctrl/Cmd+Shift+C/V for clipboard, Ctrl+L for clear,
      // Ctrl/Cmd+= / +- / +0 for font zoom.
      // Returning false from `attachCustomKeyEventHandler` suppresses xterm's
      // default; returning true lets xterm process the event (default).
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true
        const mod = e.ctrlKey || e.metaKey

        // Autocomplete ghost-text acceptance / dismissal. Tab and → accept
        // (writing the suffix into the PTY — never auto-running); Esc
        // dismisses. Accept is a no-op (falls through) when there is no
        // active suggestion, so Tab still reaches the shell for its own
        // completion and → still moves the cursor.
        const ac = acRef.current
        if (ac.enabled) {
          const applyEdit = (edit: { backspaces: number; write: string } | null): boolean => {
            if (!edit) return false
            if (edit.backspaces > 0) void session.write(DEL_BYTE.repeat(edit.backspaces))
            void session.write(edit.write)
            return true
          }
          // While the popup is open it owns ↑/↓/Enter/Tab/Esc.
          if (ac.listOpen) {
            if (e.key === "ArrowDown") {
              ac.moveSelection(1)
              return false
            }
            if (e.key === "ArrowUp") {
              ac.moveSelection(-1)
              return false
            }
            if (e.key === "Enter" || e.key === "Tab") {
              if (applyEdit(ac.acceptSelected())) return false
              ac.closeList()
              return false
            }
            if (e.key === "Escape") {
              ac.closeList()
              return false
            }
          }
          // Ctrl+Space opens the candidate popup.
          if (ac.popupEnabled && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "Space") {
            ac.openList()
            return false
          }
          if (e.key === "Escape" && ac.ghostSuggestion) {
            ac.dismiss()
            return false
          }
          if (e.key === "Tab" || (e.key === "ArrowRight" && !e.shiftKey && !e.altKey && !mod)) {
            if (applyEdit(ac.accept())) return false
            // Second Tab: no ghost to accept but candidates exist → open
            // the popup instead of falling through to shell completion.
            if (e.key === "Tab" && ac.popupEnabled && ac.candidates.length > 0) {
              ac.openList()
              return false
            }
          }
        }
        // Font zoom. `=`/`+` zoom in, `-`/`_` zoom out, `0` resets. Guard on
        // !shift for the digit so it doesn't swallow shifted symbols, but allow
        // shift for `+` (which is Shift+= on most layouts).
        if (mod && (e.key === "=" || e.key === "+")) {
          zoomRef.current += 1
          applyZoom()
          return false
        }
        if (mod && (e.key === "-" || e.key === "_")) {
          zoomRef.current -= 1
          applyZoom()
          return false
        }
        if (mod && e.key === "0") {
          zoomRef.current = 0
          applyZoom()
          return false
        }
        if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
          const sel = term.getSelection()
          if (sel && navigator.clipboard) {
            void navigator.clipboard.writeText(sel)
            return false
          }
        }
        if (mod && e.shiftKey && (e.key === "V" || e.key === "v")) {
          if (navigator.clipboard) {
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text) term.paste(text)
              })
              .catch(() => {
                /* noop */
              })
            return false
          }
        }
        // Ctrl+L → clear screen. Forward to shell as well so the shell's
        // own state stays consistent.
        if (mod && !e.shiftKey && (e.key === "L" || e.key === "l")) {
          term.clear()
          return true
        }
        return true
      })

      // Opt-in selection-copy. Skipped when copyOnSelect is false so that
      // the user's existing clipboard contents survive accidental
      // selection in the terminal.
      const selectionDisposable = term.onSelectionChange(() => {
        if (!copyOnSelect) return
        const sel = term.getSelection()
        if (!sel || !navigator.clipboard) return
        navigator.clipboard.writeText(sel).catch(() => {
          /* noop */
        })
      })

      term.open(container)

      // Renderer selection. "auto" tries WebGL → Canvas → DOM (the robust
      // default). "webgl"/"canvas" force that renderer but still fall back if
      // it refuses to initialize (some WebView2 setups break WebGL — the
      // forced choice is an *intent*, not a guarantee). "dom" skips both
      // accelerated renderers entirely (slowest, but always works) — the
      // escape hatch for "the terminal renders blank/garbled" reports.
      let webglAddon: { dispose: () => void } | null = null
      let canvasAddon: { dispose: () => void } | null = null
      const tryWebgl = renderer === "auto" || renderer === "webgl"
      const tryCanvas = renderer === "auto" || renderer === "webgl" || renderer === "canvas"
      if (tryWebgl && webglCtor) {
        try {
          webglAddon = new webglCtor()
          term.loadAddon(webglAddon as unknown as Parameters<typeof term.loadAddon>[0])
        } catch {
          webglAddon = null
        }
      }
      if (!webglAddon && tryCanvas && canvasCtor) {
        try {
          canvasAddon = new canvasCtor()
          term.loadAddon(canvasAddon as unknown as Parameters<typeof term.loadAddon>[0])
        } catch {
          canvasAddon = null
        }
      }

      // Programming-font ligatures (opt-in). Loaded after the renderer so it
      // shapes the active glyph cache. The dynamic import + try/catch mirror
      // the renderer addons: a missing module or unsupported font must not
      // crash the dock. Disposed in cleanup. Toggling the setting remounts
      // (the setup effect depends on `fontLigatures`), so we only need to
      // load — never unload — here.
      let ligaturesAddon: { dispose: () => void } | null = null
      if (fontLigatures) {
        try {
          const { LigaturesAddon } = await import("@xterm/addon-ligatures")
          if (!disposedRef.current) {
            ligaturesAddon = new LigaturesAddon()
            term.loadAddon(ligaturesAddon as unknown as Parameters<typeof term.loadAddon>[0])
          }
        } catch {
          ligaturesAddon = null
        }
      }

      // Initial fit before wiring observers so we don't ship a 1×1 PTY.
      try {
        fit.fit()
      } catch {
        // ignore — happens when the container isn't laid out yet
      }
      const initial = { rows: term.rows, cols: term.cols }
      void session.resize(initial.rows, initial.cols)

      // Single source of truth for re-fitting: recompute cols/rows from the
      // container and, when they changed, push the new size to the PTY. Shared
      // by the ResizeObserver, the zoom shortcuts, and the live-settings effect
      // (font changes alter the cell size, so a re-fit must follow).
      const refit = () => {
        try {
          fit.fit()
          if (term.rows !== initial.rows || term.cols !== initial.cols) {
            initial.rows = term.rows
            initial.cols = term.cols
            void session.resize(term.rows, term.cols)
          }
        } catch {
          // ignore — fit can throw when the container has no layout yet
        }
      }
      refitRef.current = refit

      const bp = new TerminalBackpressure({
        term: { write: (data, cb) => term.write(data, cb) },
      })
      const offData = session.onData((bytes) => bp.push(bytes))
      const offInput = term.onData((text: string) => {
        void session.write(text)
        // Mirror the keystroke into the autocomplete line model (no-op when
        // the feature is off). Accepted suffixes go through session.write
        // directly, not onData, so there's no double-feed.
        acRef.current.feed(text)
      })

      // OSC 633 command markers (1B). Register a marker + gutter decoration
      // at command_start; recolour it by exit code on command_end. The
      // store still receives the same events (via spawn-orchestrator) for
      // the history rail — this listener only owns the in-terminal gutter.
      const offIntegration = session.onIntegration((ev: IntegrationEvent) => {
        // A fresh prompt or a submitted command means the previous input
        // line is gone — reset the autocomplete line model so a stale ghost
        // doesn't linger across commands.
        if (ev.kind === "prompt_start" || ev.kind === "command_start") {
          acRef.current.reset()
        }
        if (ev.kind === "command_start") {
          const marker = term.registerMarker?.()
          if (!marker) return
          const decoration = term.registerDecoration?.({ marker })
          paintMarkerDecoration(decoration, null)
          markersRef.current.push({ marker, decoration, exitCode: null })
        } else if (ev.kind === "command_end") {
          for (let i = markersRef.current.length - 1; i >= 0; i--) {
            const entry = markersRef.current[i]
            if (entry.exitCode === null) {
              entry.exitCode = ev.exit_code
              // xterm decorations expose no recolour API — recreate it.
              entry.decoration?.dispose()
              entry.decoration = term.registerDecoration?.({ marker: entry.marker })
              paintMarkerDecoration(entry.decoration, ev.exit_code)
              break
            }
          }
        }
      })

      // File-path / error links (1D). Clickable `path:line:col` tokens open
      // in the read-only Monaco file viewer, resolved against the session's
      // current cwd (tracked in the terminal store). Coexists with
      // WebLinksAddon (URLs) — this provider only matches file paths.
      const fileLinkProvider: ILinkProvider = {
        provideLinks(bufferLineNumber, callback) {
          const text = term.buffer?.active?.getLine?.(bufferLineNumber - 1)?.translateToString(true)
          const matches = text ? matchFileLinks(text) : []
          if (matches.length === 0) {
            callback(undefined)
            return
          }
          const links: ILink[] = matches.map((mm) => ({
            text: text!.slice(mm.start, mm.start + mm.length),
            range: {
              start: { x: mm.start + 1, y: bufferLineNumber },
              end: { x: mm.start + mm.length, y: bufferLineNumber },
            },
            activate: () => {
              const cwd = useTerminalStore.getState().sessions[sessionId]?.cwd ?? null
              useFileViewerStore
                .getState()
                .openFile(resolveLinkPath(cwd, mm.path), mm.line, mm.column)
            },
          }))
          callback(links)
        },
      }
      const linkDisposable = term.registerLinkProvider?.(fileLinkProvider)

      // Watch `<html>` for `.dark` flips and retheme on demand.
      const themeObserver = new MutationObserver(() => {
        try {
          term.options.theme = makeTheme(isHtmlDark(), colorSchemeRef.current)
        } catch {
          /* noop */
        }
      })
      if (typeof document !== "undefined") {
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        })
      }

      // Resize: debounced through ResizeObserver. fit.fit() reads container
      // dimensions; we then propagate to the Rust side so the child sees
      // SIGWINCH (or ConPTY's equivalent).
      const ro = new ResizeObserver(() => {
        refit()
      })
      ro.observe(container)

      cleanup = () => {
        try {
          offInput.dispose()
        } catch {
          /* noop */
        }
        try {
          selectionDisposable.dispose()
        } catch {
          /* noop */
        }
        offData()
        offIntegration()
        try {
          linkDisposable?.dispose?.()
        } catch {
          /* noop */
        }
        for (const entry of markersRef.current) {
          try {
            entry.decoration?.dispose()
          } catch {
            /* noop */
          }
          try {
            entry.marker.dispose()
          } catch {
            /* noop */
          }
        }
        markersRef.current = []
        ro.disconnect()
        themeObserver.disconnect()
        bp.dispose()
        try {
          webglAddon?.dispose()
        } catch {
          /* noop */
        }
        try {
          canvasAddon?.dispose()
        } catch {
          /* noop */
        }
        try {
          ligaturesAddon?.dispose()
        } catch {
          /* noop */
        }
        try {
          search.dispose()
        } catch {
          /* noop */
        }
        term.dispose()
        termRef.current = null
        searchAddonRef.current = null
        refitRef.current = null
        applyZoomRef.current = null
      }
    })().catch((err) => {
      console.warn(`terminal-instance: setup failed for ${sessionId}:`, err)
    })

    return () => {
      disposedRef.current = true
      cleanup()
    }
    // copyOnSelect is read inside the selection handler each time, so we
    // don't need to re-run setup when it changes. Settings updates flow
    // through the live-settings effect below. `fontLigatures` and `renderer`
    // ARE setup deps: their addons can't be cleanly hot-swapped, so changing
    // either remounts the terminal (cheap — a fresh xterm, the PTY survives).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, fontLigatures, renderer])

  // Live settings: mutate the live xterm's options without rebuilding it.
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (!term) return
    try {
      // Track whether a font dimension changed: the cell size shifts, so the
      // container now fits a different cols/rows count and the terminal must
      // re-fit (and tell the PTY) — otherwise the layout desyncs from the font.
      let fontChanged = false
      if (term.options.fontFamily !== fontFamily) {
        term.options.fontFamily = fontFamily
        fontChanged = true
      }
      // Apply the configured size plus any active zoom delta.
      const effectiveSize = clampFontSize(fontSize + zoomRef.current)
      if (term.options.fontSize !== effectiveSize) {
        term.options.fontSize = effectiveSize
        fontChanged = true
      }
      if (term.options.scrollback !== scrollback) term.options.scrollback = scrollback
      if (term.options.cursorStyle !== cursorStyle) term.options.cursorStyle = cursorStyle
      if (term.options.cursorBlink !== cursorBlink) term.options.cursorBlink = cursorBlink
      if (fontChanged) refitRef.current?.()
    } catch {
      /* noop */
    }
  }, [fontFamily, fontSize, scrollback, cursorStyle, cursorBlink])

  // Live color-scheme switch: re-theme in place (no remount). Also keeps the
  // ref the `.dark` observer reads in sync.
  useEffect(() => {
    colorSchemeRef.current = colorScheme
    const term = termRef.current
    if (!term) return
    try {
      term.options.theme = makeTheme(isHtmlDark(), colorScheme)
    } catch {
      /* noop */
    }
  }, [colorScheme])

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={containerRef}
        data-testid="terminal-instance"
        data-session-id={sessionId}
        className="h-full w-full overflow-hidden bg-background"
      />
      {autocomplete.enabled && autocomplete.ghost ? (
        <TerminalGhostText
          ghost={autocomplete.ghost}
          left={ghostPos.left}
          top={ghostPos.top}
          fontFamily={fontFamily}
          fontSize={fontSize}
          source={autocomplete.ghostSuggestion?.source}
          acceptHint={t("ghost.acceptHint")}
        />
      ) : null}
      {autocomplete.enabled && autocomplete.listOpen ? (
        <TerminalCompletionPopup
          candidates={autocomplete.candidates}
          selectedIndex={autocomplete.selectedIndex}
          left={ghostPos.left}
          top={ghostPos.top}
          fontFamily={fontFamily}
          fontSize={fontSize}
          onPick={(index) => {
            const ac = acRef.current
            const delta = index - ac.selectedIndex
            if (delta !== 0) ac.moveSelection(delta)
            const edit = ac.acceptSelected()
            if (edit) {
              const session = getLiveSession(sessionId)
              if (session) {
                if (edit.backspaces > 0) void session.write(DEL_BYTE.repeat(edit.backspaces))
                void session.write(edit.write)
              }
            }
          }}
        />
      ) : null}
    </div>
  )
}

export const TerminalInstance = forwardRef<TerminalInstanceHandle, TerminalInstanceProps>(
  TerminalInstanceImpl
)
TerminalInstance.displayName = "TerminalInstance"

export default TerminalInstance

/**
 * Open an OSC 8 hyperlink target. Prefer Tauri's `openExternal` (writes
 * through the OS without an in-app webview hop) when running inside the
 * desktop shell; fall back to `window.open` in the browser / Capacitor
 * builds. Refuses to open unsafe schemes — only http / https / mailto
 * / file pass the allowlist. This is the same policy `WebLinksAddon`
 * enforces for plain-text URLs.
 */
function openExternalLink(uri: string): void {
  try {
    const url = new URL(uri)
    const safeSchemes = ["http:", "https:", "mailto:", "file:"]
    if (!safeSchemes.includes(url.protocol)) {
      console.warn(`terminal: refusing to open OSC 8 link with scheme "${url.protocol}"`)
      return
    }
  } catch {
    console.warn(`terminal: ignoring malformed OSC 8 URI: ${uri}`)
    return
  }
  // Best-effort dynamic import of Tauri's opener plugin so the renderer
  // can ship to Capacitor / web without the desktop dep.
  void (async () => {
    try {
      const mod = await import("@tauri-apps/plugin-opener")
      await mod.openUrl(uri)
      return
    } catch {
      /* fall through to window.open */
    }
    try {
      window.open(uri, "_blank", "noopener,noreferrer")
    } catch {
      /* both paths failed — give up silently */
    }
  })()
}
