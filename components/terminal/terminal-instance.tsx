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

import { forwardRef, useEffect, useImperativeHandle, useRef, type ForwardedRef } from "react"

import type { IDecoration, ILink, ILinkProvider, IMarker } from "@xterm/xterm"

import { TerminalBackpressure } from "@/lib/terminal/backpressure"
import { exitMarkerColor, nextMarkerLine, prevMarkerLine } from "@/lib/terminal/command-markers"
import { getLiveSession } from "@/lib/terminal/session-registry"
import { matchFileLinks, resolveLinkPath } from "@/lib/terminal/terminal-links"
import type { IntegrationEvent } from "@/lib/terminal/types"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useSettingsStore } from "@/stores/settings"

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
    el.style.position = "absolute"
    el.style.left = "0"
    el.style.width = "3px"
    el.style.height = "100%"
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

const DEFAULT_FONT_FAMILY = '"JetBrains Mono", "Cascadia Code", "Menlo", "Consolas", monospace'
const DEFAULT_FONT_SIZE = 13
const DEFAULT_SCROLLBACK = 10000

/** xterm.js theme tokens. Pulled into helpers so dock + tests can share. */
function makeTheme(isDark: boolean) {
  // Match the app's neutral palette (oklch in `globals.css`). Picked sRGB
  // approximations that look correct against the light/dark `bg-background`.
  if (isDark) {
    return {
      background: "#0a0a0a",
      foreground: "#e5e5e5",
      cursor: "#e5e5e5",
      selectionBackground: "#3b82f680",
    }
  }
  return {
    background: "#ffffff",
    foreground: "#171717",
    cursor: "#171717",
    selectionBackground: "#3b82f640",
  }
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

  const fontFamily =
    fontFamilyProp ??
    (settingsFontFamily && settingsFontFamily.length > 0 ? settingsFontFamily : DEFAULT_FONT_FAMILY)
  const fontSize =
    fontSizeProp ?? (typeof settingsFontSize === "number" ? settingsFontSize : DEFAULT_FONT_SIZE)
  const scrollback =
    scrollbackProp ??
    (typeof settingsScrollback === "number" ? settingsScrollback : DEFAULT_SCROLLBACK)
  const copyOnSelect = copyOnSelectProp ?? settingsCopyOnSelect

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

      const term = new Terminal({
        cursorBlink: true,
        fontFamily,
        fontSize,
        scrollback,
        allowProposedApi: true,
        theme: makeTheme(isHtmlDark()),
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

      // Keyboard handlers: Ctrl/Cmd+Shift+C/V for clipboard, Ctrl+L for clear.
      // Returning false from `attachCustomKeyEventHandler` suppresses xterm's
      // default; returning true lets xterm process the event (default).
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true
        const mod = e.ctrlKey || e.metaKey
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

      // Try WebGL first; fall back to canvas. Both are quiet about errors —
      // if neither loads, xterm uses its built-in DOM renderer.
      let webglAddon: { dispose: () => void } | null = null
      let canvasAddon: { dispose: () => void } | null = null
      if (webglCtor) {
        try {
          webglAddon = new webglCtor()
          term.loadAddon(webglAddon as unknown as Parameters<typeof term.loadAddon>[0])
        } catch {
          webglAddon = null
        }
      }
      if (!webglAddon && canvasCtor) {
        try {
          canvasAddon = new canvasCtor()
          term.loadAddon(canvasAddon as unknown as Parameters<typeof term.loadAddon>[0])
        } catch {
          canvasAddon = null
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

      const bp = new TerminalBackpressure({
        term: { write: (data, cb) => term.write(data, cb) },
      })
      const offData = session.onData((bytes) => bp.push(bytes))
      const offInput = term.onData((text: string) => {
        void session.write(text)
      })

      // OSC 633 command markers (1B). Register a marker + gutter decoration
      // at command_start; recolour it by exit code on command_end. The
      // store still receives the same events (via spawn-orchestrator) for
      // the history rail — this listener only owns the in-terminal gutter.
      const offIntegration = session.onIntegration((ev: IntegrationEvent) => {
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
          term.options.theme = makeTheme(isHtmlDark())
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
          search.dispose()
        } catch {
          /* noop */
        }
        term.dispose()
        termRef.current = null
        searchAddonRef.current = null
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
    // through the live-settings effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Live settings: mutate the live xterm's options without rebuilding it.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      if (term.options.fontFamily !== fontFamily) term.options.fontFamily = fontFamily
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
      if (term.options.scrollback !== scrollback) term.options.scrollback = scrollback
    } catch {
      /* noop */
    }
  }, [fontFamily, fontSize, scrollback])

  return (
    <div
      ref={containerRef}
      data-testid="terminal-instance"
      data-session-id={sessionId}
      className="h-full w-full overflow-hidden bg-background"
    />
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
