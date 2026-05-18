"use client"

import { useEffect, useRef } from "react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { useTheme } from "next-themes"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import {
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
} from "@/lib/editor-workbench/monaco-workbench"
import type { MonacoLanguage } from "./language-from-path"

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
}

export function SkillMonacoEditor({
  value,
  language,
  onChange,
  readOnly,
  skillId,
  documentId,
}: Props) {
  const { resolvedTheme } = useTheme()
  const handleRef = useRef<MonacoWorkbenchHandle | null>(null)

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

  const handleMount: OnMount = (editor, monaco) => {
    if (!skillId || !documentId) return
    handleRef.current = mountMonacoWorkbench(
      editor as unknown as IMonacoEditor,
      monaco as unknown as MonacoNamespace,
      {
        surface: "skill",
        skillId,
        documentId,
        language,
        initialContent: value,
      }
    )
  }

  return (
    <Editor
      value={value}
      language={language}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
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
  )
}
