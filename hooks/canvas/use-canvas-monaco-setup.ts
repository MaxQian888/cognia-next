"use client"

/**
 * cognia-next implementation of `useCanvasMonacoSetup`. Configures a
 * Monaco editor instance with our snippet/theme/symbol registries +
 * the canvas-settings options. The Cognia version layers an inline
 * AI-completion orchestrator on top; cognia-next leaves that to the
 * separate suggestions panel so this hook is just the editor wiring.
 */

import { useCallback, useEffect, useRef } from "react"
import type { editor as MonacoEditor } from "monaco-editor"
import { useTheme } from "next-themes"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { snippetProvider } from "@/lib/canvas/snippets/snippet-registry"
import { symbolParser } from "@/lib/canvas/symbols/symbol-parser"
import { themeRegistry } from "@/lib/canvas/themes/theme-registry"
import { pluginManager } from "@/lib/canvas/plugins/plugin-manager"
import { registerAllSnippets, registerEmmetSupport } from "@/lib/monaco/snippets"
import { bindMonacoEditorContext } from "@/lib/editor-workbench/monaco-context-binding"
import { loggers } from "@/lib/logger"

export interface UseCanvasMonacoSetupOptions {
  documentId?: string
  language?: string
}

export function useCanvasMonacoSetup(opts: UseCanvasMonacoSetupOptions = {}) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null)
  const settings = useCanvasSettingsStore((s) => s.settings)
  const themePref = useCanvasSettingsStore((s) => s.settings.theme)
  const { resolvedTheme } = useTheme()

  const editorOptions = useCanvasSettingsStore((s) => s.getEditorOptions())

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

      // Bind to the editor-workbench registry so plugins can find us.
      const dispose = bindMonacoEditorContext({
        editorId: opts.documentId ?? "canvas",
        documentId: opts.documentId,
        language: opts.language,
        getValue: () => editor.getValue(),
      })
      ;(editor as { __cogniaDisposeContext?: () => void }).__cogniaDisposeContext = dispose.dispose
    },
    [opts.documentId, opts.language]
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

  useEffect(() => {
    return () => {
      const editor = editorRef.current as
        | (MonacoEditor.IStandaloneCodeEditor & { __cogniaDisposeContext?: () => void })
        | null
      editor?.__cogniaDisposeContext?.()
    }
  }, [])

  return {
    editorRef,
    monacoRef,
    onMount,
    editorOptions,
    settings,
  }
}
