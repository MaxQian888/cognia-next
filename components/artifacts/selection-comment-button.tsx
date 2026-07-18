"use client"

/**
 * SelectionCommentButton - stages the user's current text selection inside an
 * artifact (plus a comment) as a chat context chip. The selection is captured
 * on mousedown — clicking a button would otherwise collapse the DOM selection
 * before the click handler runs.
 */

import { useState, useRef } from "react"
import { useTranslations } from "next-intl"
import { MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useChatStore } from "@/stores/chat"
import type { Artifact } from "@/types"

/**
 * Locate a selected snippet inside the artifact content and return its 1-based
 * line range. Falls back to line 1 when the snippet can't be matched verbatim
 * (e.g. the rendered text normalised whitespace).
 */
export function locateSelectionRange(
  content: string,
  snippet: string
): { startLine: number; endLine: number } {
  const index = content.indexOf(snippet)
  if (index === -1) {
    return { startLine: 1, endLine: 1 }
  }
  const startLine = content.slice(0, index).split("\n").length
  const endLine = startLine + snippet.split("\n").length - 1
  return { startLine, endLine }
}

interface SelectionCommentButtonProps {
  artifact: Artifact
  className?: string
}

export function SelectionCommentButton({ artifact, className }: SelectionCommentButtonProps) {
  const t = useTranslations("artifacts.review")
  const addArtifactSelection = useChatStore((s) => s.addArtifactSelection)

  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState("")
  const capturedRef = useRef<{ snapshot: string; startLine: number; endLine: number } | null>(null)
  const [snapshot, setSnapshot] = useState("")

  const captureSelection = () => {
    // Client-only component (mounted in the artifact panel), so `window` is
    // always present here.
    const text = (window.getSelection()?.toString() ?? "").trim()
    if (!text) {
      capturedRef.current = null
      setSnapshot("")
      window.dispatchEvent(
        new CustomEvent("artifact-context-selection", {
          detail: { artifactId: artifact.id, start: 0, end: 0 },
        })
      )
      return
    }
    const range = locateSelectionRange(artifact.content, text)
    capturedRef.current = { snapshot: text, ...range }
    setSnapshot(text)
    const start = artifact.content.indexOf(text)
    window.dispatchEvent(
      new CustomEvent("artifact-context-selection", {
        detail: {
          artifactId: artifact.id,
          start: Math.max(0, start),
          end: start < 0 ? 0 : start + text.length,
        },
      })
    )
  }

  const confirm = () => {
    const captured = capturedRef.current
    if (!captured) return
    addArtifactSelection({
      artifactId: artifact.id,
      title: artifact.title,
      snapshot: captured.snapshot,
      comment,
      range: { startLine: captured.startLine, endLine: captured.endLine },
    })
    setComment("")
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={className}
          data-testid="selection-comment-trigger"
          // Capture before the click collapses the selection.
          onMouseDown={captureSelection}
          onClick={() => setOpen(true)}
        >
          <MessageSquarePlus className="h-4 w-4 mr-1" />
          {t("commentOnSelection")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2">
        {snapshot ? (
          <pre className="max-h-24 overflow-auto rounded border bg-muted/40 p-2 text-[11px] font-mono whitespace-pre-wrap">
            {snapshot}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        )}
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t("selectionCommentPlaceholder")}
          rows={3}
          className="text-sm"
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={!snapshot} onClick={confirm}>
            {t("addToChat")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
