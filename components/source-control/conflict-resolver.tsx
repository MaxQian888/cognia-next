"use client"

/**
 * Merge-conflict resolver: a side-by-side Monaco diff of "current" (ours) vs
 * "incoming" (theirs) for the selected conflicted file, plus accept buttons.
 * "Accept Both" sends a merged buffer (ours then theirs); the single-side
 * actions check out that stage and mark the path resolved.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef } from "react"
import dynamic from "next/dynamic"
import type { editor as MonacoEditor } from "monaco-editor"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import { guardDiffEditorModelDisposal } from "@/lib/canvas/monaco-diff-disposal"
import {
  COGNIA_ACTIVE_THEME_ID,
  syncCogniaActiveTheme,
} from "@/lib/canvas/themes/cognia-active-theme"
import { resolveActiveThemeColors } from "@/lib/themes"
import { useSettingsStore } from "@/stores"
import { languageFromPath } from "@/lib/git/language-map"
import type { ConflictSide, GitConflict } from "@/types/git"

const MonacoDiff = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => <Spinner className="m-4 size-4" />,
})

interface ConflictResolverProps {
  conflict: GitConflict
  onResolve?: (resolution: { mergedContent?: string; side?: ConflictSide }) => void
}

export function ConflictResolver({ conflict, onResolve }: ConflictResolverProps) {
  const t = useTranslations("sourceControl")
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null)

  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

  useEffect(() => {
    configureMonacoLoader()
  }, [])

  // Paint the conflict diff with the user's appearance palette (cognia-active),
  // matching the canvas / skills editors instead of stock VS Code.
  const applyActiveTheme = useCallback(
    (monaco: typeof import("monaco-editor")) => {
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
      // Re-apply explicitly so an already-mounted editor follows a light/dark
      // toggle (see DiffViewer for the rationale).
      monaco.editor.setTheme(COGNIA_ACTIVE_THEME_ID)
    },
    [resolvedTheme, appearanceColorTheme, appearanceActiveCustomThemeId, appearanceCustomThemes]
  )

  useEffect(() => {
    if (monacoRef.current) applyActiveTheme(monacoRef.current)
  }, [applyActiveTheme])

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === "undefined") return
    let pending: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        editorRef.current?.layout()
      }, 60)
    })
    observer.observe(container)
    return () => {
      if (pending) clearTimeout(pending)
      observer.disconnect()
    }
  }, [])

  const options = useMemo<MonacoEditor.IStandaloneDiffEditorConstructionOptions>(
    () => ({
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
    }),
    []
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="conflict-resolver">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <span className="mr-2 truncate text-xs font-medium" title={conflict.path}>
          {conflict.path}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs"
          onClick={() => onResolve?.({ side: "ours" })}
          disabled={!onResolve}
          data-testid="accept-ours"
        >
          {t("conflicts.acceptOurs")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs"
          onClick={() => onResolve?.({ side: "theirs" })}
          disabled={!onResolve}
          data-testid="accept-theirs"
        >
          {t("conflicts.acceptTheirs")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs"
          onClick={() => onResolve?.({ mergedContent: mergeBoth(conflict) })}
          disabled={!onResolve}
          data-testid="accept-both"
        >
          {t("conflicts.acceptBoth")}
        </Button>
      </div>
      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<Spinner className="m-4 size-4" />}>
          <MonacoDiff
            original={conflict.ours}
            modified={conflict.theirs}
            language={languageFromPath(conflict.path)}
            theme={COGNIA_ACTIVE_THEME_ID}
            options={options}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              guardDiffEditorModelDisposal(editor)
              monacoRef.current = monaco
              applyActiveTheme(monaco)
            }}
          />
        </Suspense>
      </div>
    </div>
  )
}

/** "Accept both" — keep current then incoming, separated by a newline. */
export function mergeBoth(conflict: GitConflict): string {
  const ours = conflict.ours.endsWith("\n") ? conflict.ours : `${conflict.ours}\n`
  return `${ours}${conflict.theirs}`
}
