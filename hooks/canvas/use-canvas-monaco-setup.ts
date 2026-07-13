"use client"

/**
 * cognia-next implementation of `useCanvasMonacoSetup`. Configures a
 * Monaco editor instance with our snippet/theme/symbol registries +
 * the canvas-settings options. The Cognia version layers an inline
 * AI-completion orchestrator on top; cognia-next leaves that to the
 * separate suggestions panel so this hook is just the editor wiring.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { editor as MonacoEditor } from "monaco-editor"
import { useTheme } from "next-themes"
import type { MonacoLike, EditorLike } from "@/hooks/use-monaco-markers"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { useKeybindingStore } from "@/stores/canvas/keybinding-store"
import { useSettingsStore } from "@/stores"
import {
  COGNIA_ACTIVE_THEME_ID,
  syncCogniaActiveTheme,
} from "@/lib/canvas/themes/cognia-active-theme"
import { resolveActiveThemeColors } from "@/lib/themes"
import { registerAllSnippets, registerEmmetSupport } from "@/lib/monaco/snippets"
import {
  registerCanvasEditorActions,
  type MonacoDisposable,
} from "@/lib/canvas/register-canvas-editor-actions"
import {
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
} from "@/lib/editor-workbench/monaco-workbench"
import { loggers } from "@cognia/logging"

export interface UseCanvasMonacoSetupOptions {
  documentId?: string
  language?: string
  /**
   * Canvas session id; combined with `documentId` to form the stable
   * `canvas:///{sessionId}/{documentId}.{ext}` URI that the VS Code
   * reuse layer binds LSP providers to.
   */
  sessionId?: string
  /**
   * Initial content for the underlying Monaco model. Only consumed on
   * first mount; subsequent value changes ride through `editor.setValue`.
   */
  initialContent?: string
}

export function useCanvasMonacoSetup(opts: UseCanvasMonacoSetupOptions = {}) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null)
  const workbenchHandleRef = useRef<MonacoWorkbenchHandle | null>(null)
  const editorActionsRef = useRef<MonacoDisposable[]>([])
  // Live monaco + editor for the diagnostics bar. State (not a ref) so the bar
  // re-renders once Monaco mounts and LSP markers start flowing. Owned here (the
  // hook manages the editor lifecycle) rather than in the panel, which keeps the
  // panel's onMount side-effect-free.
  const [diagnostics, setDiagnostics] = useState<{ monaco: MonacoLike; editor: EditorLike } | null>(
    null
  )
  const settings = useCanvasSettingsStore((s) => s.settings)
  // Subscribe to the customizable keybindings so a rebind re-registers the
  // editor actions (the effect below keys off this value).
  const keybindings = useKeybindingStore((s) => s.bindings)
  const themePref = useCanvasSettingsStore((s) => s.settings.theme)
  const highContrast = useCanvasSettingsStore((s) => s.settings.accessibility.highContrast)
  const { resolvedTheme } = useTheme()

  const monacoLink = useSettingsStore((s) => s.monacoLink)
  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

  const getEditorOptions = useCanvasSettingsStore((s) => s.getEditorOptions)
  const editorSettings = useCanvasSettingsStore((s) => s.settings.editor)
  const accessibilitySettings = useCanvasSettingsStore((s) => s.settings.accessibility)
  const editorOptions = useMemo(() => {
    // editorSettings + accessibilitySettings both feed getEditorOptions (the
    // latter for accessibilitySupport + the reduced-motion overrides); reading
    // them here re-derives Monaco options whenever either slice changes.
    void editorSettings
    void accessibilitySettings
    return getEditorOptions()
  }, [getEditorOptions, editorSettings, accessibilitySettings])

  const onMount = useCallback(
    (editor: MonacoEditor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
      editorRef.current = editor
      monacoRef.current = monaco
      try {
        registerAllSnippets(monaco)
        registerEmmetSupport(monaco)
      } catch (err) {
        loggers.canvas.warn("monaco setup hook failed", { err: String(err) })
      }

      // Apply the user's customizable editor keybindings (find/replace/format,
      // the net-new word-wrap/minimap toggles, folding, …) to this editor.
      // Registered here (not only in the effect) so a document switch — which
      // remounts Monaco with a fresh editor — always rebinds against the new
      // instance. The effect below re-applies them when the user rebinds a key.
      editorActionsRef.current.forEach((d) => d.dispose())
      editorActionsRef.current = registerCanvasEditorActions(
        editor,
        monaco,
        useKeybindingStore.getState().bindings
      )

      // Expose the live handles to the diagnostics bar.
      setDiagnostics({
        monaco: monaco as unknown as MonacoLike,
        editor: editor as unknown as EditorLike,
      })

      // Mount the workbench primitive so this editor is visible to the
      // VS Code reuse layer (LSP providers, decorations, diagnostics)
      // under the `canvas:///` URI scheme. The primitive also calls
      // `bindMonacoEditorContext` internally so the existing snippets /
      // outline registry continues to see the editor unchanged.
      if (opts.documentId) {
        try {
          workbenchHandleRef.current = mountMonacoWorkbench(
            editor as unknown as IMonacoEditor,
            monaco as unknown as MonacoNamespace,
            {
              surface: "canvas",
              documentId: opts.documentId,
              sessionId: opts.sessionId,
              language: opts.language ?? "plaintext",
              initialContent: opts.initialContent ?? editor.getValue() ?? "",
            }
          )
        } catch (err) {
          loggers.canvas.warn("monaco workbench mount failed", { err: String(err) })
        }
      }
    },
    [opts.documentId, opts.sessionId, opts.language, opts.initialContent]
  )

  // Single source of truth for the Monaco theme id. Resolves the same way the
  // panel used to (and no longer does), so there is exactly one writer of
  // `monaco.editor.setTheme` — the dual-write between the panel's `theme` prop
  // and this hook was the cause of the editor/app theme disagreeing.
  //
  //   1. High contrast (accessibility) overrides everything.
  //   2. An app-level lock (Settings → Appearance → Advanced) pins a base theme.
  //   3. An explicit per-canvas pick (vs / monokai / …) wins next.
  //   4. Linking off → stock `vs-dark`, standalone from the app theme.
  //   5. Otherwise → the cognia-active theme derived from the live app palette,
  //      so "auto" actually matches the user's chosen colors instead of the
  //      generic VS Code light/dark defaults.
  const resolvedThemeId = useMemo(() => {
    if (highContrast) return resolvedTheme === "dark" ? "hc-black" : "hc-light"
    if (monacoLink.lockedThemeId) return monacoLink.lockedThemeId
    if (themePref && themePref !== "auto") return themePref
    if (!monacoLink.enabled) return "vs-dark"
    return COGNIA_ACTIVE_THEME_ID
  }, [highContrast, monacoLink, themePref, resolvedTheme])

  // Apply the resolved theme. When the target is cognia-active we (re)build it
  // from the current appearance palette + light/dark variant first, because the
  // theme id stays "cognia-active" across a light↔dark flip — Monaco only
  // repaints on a `setTheme` call, so redefining alone wouldn't refresh it.
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco || !resolvedTheme) return
    if (resolvedThemeId === COGNIA_ACTIVE_THEME_ID) {
      const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
      const resolved = resolveActiveThemeColors({
        colorTheme: appearanceColorTheme,
        resolvedTheme: variant,
        activeCustomThemeId: appearanceActiveCustomThemeId,
        customThemes: appearanceCustomThemes,
      })
      try {
        syncCogniaActiveTheme(monaco, resolved.colors, variant)
      } catch (err) {
        loggers.canvas.warn("cognia-active monaco theme sync failed", { err: String(err) })
      }
    }
    try {
      monaco.editor.setTheme(resolvedThemeId)
    } catch {
      // Theme not registered yet — registry registers built-ins on mount and
      // the panel's `theme` prop re-applies once it is.
    }
  }, [
    resolvedThemeId,
    resolvedTheme,
    appearanceColorTheme,
    appearanceActiveCustomThemeId,
    appearanceCustomThemes,
  ])

  // Tear the workbench down when the editor unmounts OR when the
  // surface identity (documentId/sessionId) changes. The workbench's
  // dispose also tears down `bindMonacoEditorContext`.
  useEffect(() => {
    return () => {
      workbenchHandleRef.current?.dispose()
      workbenchHandleRef.current = null
    }
  }, [opts.documentId, opts.sessionId])

  // Re-apply editor keybindings when the user rebinds a key (the editor stays
  // mounted, so onMount doesn't re-run). Initial mount is handled by onMount;
  // this fires only when `keybindings` actually changes.
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    editorActionsRef.current.forEach((d) => d.dispose())
    editorActionsRef.current = registerCanvasEditorActions(editor, monaco, keybindings)
  }, [keybindings])

  // Dispose the registered editor actions on unmount.
  useEffect(() => {
    return () => {
      editorActionsRef.current.forEach((d) => d.dispose())
      editorActionsRef.current = []
    }
  }, [])

  return {
    editorRef,
    monacoRef,
    onMount,
    editorOptions,
    settings,
    diagnostics,
    /** Single-writer Monaco theme id — pass straight to the editor `theme` prop. */
    resolvedThemeId,
  }
}
