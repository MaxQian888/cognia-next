"use client"

/**
 * DiffViewer — Monaco `DiffEditor` for a single file, with per-hunk gutter
 * actions (Stage / Unstage / Discard Hunk). Reuses the Canvas Monaco setup:
 * `configureMonacoLoader` (offline assets), `automaticLayout: true` so Monaco
 * sizes itself once the container has dimensions (the editor mounts async via
 * `dynamic`, so a manual size-on-mount would race), plus the ResizeObserver
 * `layout()` backstop for the flex-shrink bug (microsoft/monaco-editor#3393).
 */

import { Suspense, useCallback, useEffect, useMemo, useRef } from "react"
import dynamic from "next/dynamic"
import type { editor as MonacoEditor } from "monaco-editor"
import { useTranslations } from "next-intl"
import { CheckIcon, MinusIcon, Undo2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { FileQuestionIcon } from "lucide-react"
import { useMonacoActiveTheme } from "@/hooks/git/use-monaco-active-theme"
import type { GitDiff, GitHunk } from "@/types/git"

const MonacoDiff = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => <DiffLoading />,
})

function DiffLoading() {
  const t = useTranslations("sourceControl")
  return (
    <div className="flex h-full items-center justify-center bg-muted/20 text-sm text-muted-foreground">
      <Spinner className="mr-2 size-4" />
      {t("diff.loading")}
    </div>
  )
}

export interface HunkAction {
  label: string
  icon: "stage" | "unstage" | "discard"
  onClick: (hunk: GitHunk) => void
}

interface DiffViewerProps {
  diff: GitDiff | null
  /** Whether the diff represents staged (HEAD↔index) content. */
  staged: boolean
  /** Per-hunk actions rendered as a small overlay bar. */
  hunkActions?: HunkAction[]
  /** Read-only original side (always true here — diffs aren't edited inline). */
  readOnly?: boolean
}

const ICON = {
  stage: CheckIcon,
  unstage: MinusIcon,
  discard: Undo2Icon,
} as const

export function DiffViewer({ diff, hunkActions = [] }: DiffViewerProps) {
  const t = useTranslations("sourceControl")
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null)
  const { themeId, registerMonaco } = useMonacoActiveTheme()

  // Scroll the modified side to a hunk's first line and place the caret there.
  const revealHunk = useCallback((hunk: GitHunk) => {
    const modified = editorRef.current?.getModifiedEditor()
    if (!modified) return
    modified.revealLineInCenter(hunk.newStart)
    modified.setPosition({ lineNumber: hunk.newStart, column: 1 })
    modified.focus()
  }, [])

  // Flex-shrink layout fix (see canvas-panel.tsx for the rationale).
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
      renderOverviewRuler: false,
    }),
    []
  )

  if (!diff) {
    return (
      <Empty className="h-full border-0" data-testid="diff-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestionIcon />
          </EmptyMedia>
          <EmptyDescription>{t("diff.selectFile")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (diff.isBinary) {
    return (
      <Empty className="h-full border-0" data-testid="diff-binary">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestionIcon />
          </EmptyMedia>
          <EmptyDescription>{t("diff.binary")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="diff-viewer">
      {hunkActions.length > 0 && diff.hunks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">
            {t("diff.hunkCount", { count: diff.hunks.length })}
          </span>
          {diff.hunks.map((hunk, i) => (
            <div
              key={`${hunk.header}-${i}`}
              className="flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5"
              data-testid={`hunk-row-${i}`}
            >
              <button
                type="button"
                className="rounded font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => revealHunk(hunk)}
                aria-label={t("diff.jumpToHunk", { line: hunk.newStart })}
                title={t("diff.jumpToHunk", { line: hunk.newStart })}
                data-testid={`hunk-jump-${i}`}
              >
                @@ {hunk.newStart}
              </button>
              {hunkActions.map((action) => {
                const Icon = ICON[action.icon]
                return (
                  <Button
                    key={action.icon}
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    aria-label={action.label}
                    title={action.label}
                    onClick={() => action.onClick(hunk)}
                    data-testid={`hunk-${action.icon}-${i}`}
                  >
                    <Icon className="size-3" />
                  </Button>
                )
              })}
            </div>
          ))}
        </div>
      )}
      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<DiffLoading />}>
          <MonacoDiff
            original={diff.oldContent}
            modified={diff.newContent}
            language={diff.language ?? "plaintext"}
            theme={themeId}
            options={options}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              registerMonaco(monaco)
            }}
          />
        </Suspense>
      </div>
    </div>
  )
}
