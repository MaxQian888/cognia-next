"use client"

import { useEffect, useRef, useState } from "react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { useTheme } from "next-themes"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import {
  COGNIA_ACTIVE_THEME_ID,
  syncCogniaActiveTheme,
} from "@/lib/canvas/themes/cognia-active-theme"
import { useSettingsStore } from "@/stores"
import { resolveActiveThemeColors } from "@/lib/themes"
import {
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
} from "@/lib/editor-workbench/monaco-workbench"
import type { MonacoLanguage } from "./language-from-path"
import { LspServerHint } from "@/components/editor/lsp-server-hint"
import { MonacoDiagnosticsBar } from "@/components/editor/monaco-diagnostics-bar"
import type { MonacoLike, EditorLike } from "@/hooks/use-monaco-markers"

interface Props {
  value: string
  language: MonacoLanguage
  onChange: (next: string) => void
  readOnly?: boolean
  /**
   * Owning skill id; combined with `documentId` to build the stable
   * `skill:///{skillId}/{documentId}.{ext}` URI the VS Code reuse layer
   * uses to address this editor.
   */
  skillId?: string
  /**
   * Stable per-file id (usually the row id of `skillFiles`). The caller
   * should pass `key={documentId}` on the host so React tears down + re-
   * mounts the editor when the active file switches; the workbench's URI
   * is derived from this prop.
   */
  documentId?: string
  /** Real bundle-relative path used by the shared multi-file LSP workspace. */
  path?: string
}

export function SkillMonacoEditor({
  value,
  language,
  onChange,
  readOnly,
  skillId,
  documentId,
  path,
}: Props) {
  const { resolvedTheme } = useTheme()
  const handleRef = useRef<MonacoWorkbenchHandle | null>(null)
  const monacoRef = useRef<MonacoNamespace | null>(null)
  // Captured on mount so the diagnostics bar can read this editor's markers.
  const [diag, setDiag] = useState<{ monaco: MonacoLike; editor: EditorLike } | null>(null)

  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

  useEffect(() => {
    configureMonacoLoader()
  }, [])

  // Tear down the workbench when the component unmounts OR when document
  // identity changes. Callers should re-key the editor by `documentId`
  // for a clean unmount/remount on file switches; this effect is the
  // defensive net in case they don't.
  useEffect(() => {
    return () => {
      handleRef.current?.dispose()
      handleRef.current = null
    }
  }, [skillId, documentId])

  // Keep the cognia-active Monaco theme in sync with the live appearance
  // palette so the skill editor paints with the user's chosen colors.
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco) return
    if (!resolvedTheme) return
    const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
    const resolved = resolveActiveThemeColors({
      colorTheme: appearanceColorTheme,
      resolvedTheme: variant,
      activeCustomThemeId: appearanceActiveCustomThemeId,
      customThemes: appearanceCustomThemes,
    })
    syncCogniaActiveTheme(
      monaco as unknown as Parameters<typeof syncCogniaActiveTheme>[0],
      resolved.colors,
      variant
    )
  }, [resolvedTheme, appearanceColorTheme, appearanceActiveCustomThemeId, appearanceCustomThemes])

  const handleMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco as unknown as MonacoNamespace
    setDiag({
      monaco: monaco as unknown as MonacoLike,
      editor: editor as unknown as EditorLike,
    })
    if (!resolvedTheme) {
      // Defer; the effect above will register once next-themes settles.
    } else {
      const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
      const resolved = resolveActiveThemeColors({
        colorTheme: appearanceColorTheme,
        resolvedTheme: variant,
        activeCustomThemeId: appearanceActiveCustomThemeId,
        customThemes: appearanceCustomThemes,
      })
      syncCogniaActiveTheme(
        monaco as unknown as Parameters<typeof syncCogniaActiveTheme>[0],
        resolved.colors,
        variant
      )
    }
    if (!skillId || !documentId) return
    handleRef.current = mountMonacoWorkbench(
      editor as unknown as IMonacoEditor,
      monaco as unknown as MonacoNamespace,
      {
        surface: "skill",
        skillId,
        documentId,
        pathSegments: path?.split("/").filter(Boolean),
        language,
        initialContent: value,
      }
    )
  }

  return (
    <div className="flex h-full flex-col">
      <LspServerHint language={language} />
      <div className="min-h-0 flex-1">
        <Editor
          value={value}
          language={language}
          theme={COGNIA_ACTIVE_THEME_ID}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            renderWhitespace: "selection",
          }}
          onChange={(v) => onChange(v ?? "")}
          onMount={handleMount}
          height="100%"
        />
      </div>
      <MonacoDiagnosticsBar monaco={diag?.monaco ?? null} editor={diag?.editor ?? null} />
    </div>
  )
}
