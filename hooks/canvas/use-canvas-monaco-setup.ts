"use client"

/**
 * cognia-next implementation of `useCanvasMonacoSetup`. Configures a
 * Monaco editor instance with our snippet/theme/symbol registries +
 * the canvas-settings options. The Cognia version layers an inline
 * AI-completion orchestrator on top; cognia-next leaves that to the
 * separate suggestions panel so this hook is just the editor wiring.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import type { editor as MonacoEditor } from "monaco-editor"
import { useTheme } from "next-themes"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { snippetProvider } from "@/lib/canvas/snippets/snippet-registry"
import { symbolParser } from "@/lib/canvas/symbols/symbol-parser"
import { themeRegistry } from "@/lib/canvas/themes/theme-registry"
import { pluginManager } from "@/lib/canvas/plugins/plugin-manager"
import { registerAllSnippets, registerEmmetSupport } from "@/lib/monaco/snippets"
import {
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
} from "@/lib/editor-workbench/monaco-workbench"
import { loggers } from "@/lib/logger"

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
  const settings = useCanvasSettingsStore((s) => s.settings)
  const themePref = useCanvasSettingsStore((s) => s.settings.theme)
  const { resolvedTheme } = useTheme()

  const getEditorOptions = useCanvasSettingsStore((s) => s.getEditorOptions)
  const editorSettings = useCanvasSettingsStore((s) => s.settings.editor)
  const editorOptions = useMemo(() => {
    // editorSettings drives Monaco option regeneration; reading it inside the
    // body satisfies exhaustive-deps without an extra reference.
    void editorSettings
    return getEditorOptions()
  }, [getEditorOptions, editorSettings])

  const onMount = useCallback(
    (editor: MonacoEditor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
      editorRef.current = editor
      monacoRef.current = monaco
      try {
        registerAllSnippets(monaco)
        registerEmmetSupport(monaco)
        // The Cognia registry helpers expose richer hooks; cognia-next
        // calls them defensively via `as any` because we ship a
        // simplified registry layer.
        const tr = themeRegistry as unknown as {
          applyTo?: (m: unknown) => void
        }
        tr.applyTo?.(monaco)
        const sp = snippetProvider as unknown as {
          registerWithMonaco?: (m: unknown) => void
        }
        sp.registerWithMonaco?.(monaco)
        const sy = symbolParser as unknown as {
          registerWithMonaco?: (m: unknown, lang?: string) => void
        }
        sy.registerWithMonaco?.(monaco, opts.language)
        const pm = pluginManager as unknown as {
          notifyEditorReady?: (ctx: { editor: unknown; monaco: unknown }) => void
        }
        pm.notifyEditorReady?.({ editor, monaco })
      } catch (err) {
        loggers.canvas.warn("monaco setup hook failed", { err: String(err) })
      }

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

  // Track explicit Monaco theme name with auto-fallback to system theme.
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco) return
    const target =
      themePref && themePref !== "auto" ? themePref : resolvedTheme === "dark" ? "vs-dark" : "vs"
    try {
      monaco.editor.setTheme(target)
    } catch {
      // Theme not registered yet — registry registers built-ins on mount.
    }
  }, [themePref, resolvedTheme])

  // Tear the workbench down when the editor unmounts OR when the
  // surface identity (documentId/sessionId) changes. The workbench's
  // dispose also tears down `bindMonacoEditorContext`.
  useEffect(() => {
    return () => {
      workbenchHandleRef.current?.dispose()
      workbenchHandleRef.current = null
    }
  }, [opts.documentId, opts.sessionId])

  return {
    editorRef,
    monacoRef,
    onMount,
    editorOptions,
    settings,
  }
}
