"use client"

import { useEffect } from "react"
import Editor from "@monaco-editor/react"
import { useTheme } from "next-themes"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import type { MonacoLanguage } from "./language-from-path"

interface Props {
  value: string
  language: MonacoLanguage
  onChange: (next: string) => void
  readOnly?: boolean
}

export function SkillMonacoEditor({ value, language, onChange, readOnly }: Props) {
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    configureMonacoLoader()
  }, [])

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
      height="100%"
    />
  )
}
