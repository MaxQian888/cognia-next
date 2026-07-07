"use client"

/**
 * CanvasReviewView — Codex-style per-hunk review of an AI revision to a Canvas
 * document. A structural sibling of `ArtifactReviewView`: it reuses the same
 * `ReviewHunkItem` rows, Monaco `DiffEditor`, and diff helpers, but binds to the
 * canvas-scoped store mutators (`proposeCanvasReview` / `applyCanvasReview` /
 * `rejectCanvasReview`) and the shared `pendingReviews` map keyed by document id.
 *
 * Desktop shows a side-by-side Monaco diff; mobile falls back to a lightweight
 * inline diff. Both drive the same accept/reject hunk list and apply/reject
 * footer, with a stale banner when the buffer moved out from under the proposal.
 */

import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"
import { computeDiff, computeDiffStats, getMonacoLanguage } from "@/lib/artifacts"
import { cn } from "@/lib/utils"
import { ReviewHunkItem } from "@/components/artifacts/review-hunk-item"

const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full space-y-2 p-4">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ),
})

export type CanvasReviewPanelMode = "desktop" | "mobile"

interface CanvasReviewViewProps {
  documentId: string
  /** "mobile" swaps the Monaco diff for a lightweight inline diff. */
  panelMode: CanvasReviewPanelMode
  className?: string
}

function monacoTheme(theme?: string): string {
  return theme === "dark" ? "vs-dark" : "vs"
}

export function CanvasReviewView({ documentId, panelMode, className }: CanvasReviewViewProps) {
  const t = useTranslations("artifacts.review")
  const theme = useSettingsStore((state) => state.settings?.theme)

  const review = useArtifactStore((state) => state.pendingReviews[documentId] ?? null)
  const doc = useArtifactStore((state) => state.canvasDocuments[documentId])
  const setReviewItemStatus = useArtifactStore((state) => state.setReviewItemStatus)
  const applyCanvasReview = useArtifactStore((state) => state.applyCanvasReview)
  const rejectCanvasReview = useArtifactStore((state) => state.rejectCanvasReview)
  const proposeCanvasReview = useArtifactStore((state) => state.proposeCanvasReview)

  if (!review) {
    return null
  }

  const stats = computeDiffStats(computeDiff(review.originalContent, review.proposedContent))
  const acceptedCount = review.items.filter((item) => item.status === "accepted").length
  const total = review.items.length
  const isStale = review.isStale === true
  const language = getMonacoLanguage(doc?.language || "plaintext")

  return (
    <div data-testid="canvas-review-view" className={cn("flex h-full min-h-0 flex-col", className)}>
      {isStale && (
        <div
          data-testid="canvas-review-stale-banner"
          className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{t("staleBanner")}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => proposeCanvasReview(documentId, review.proposedContent)}
          >
            {t("reDiff")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => rejectCanvasReview(documentId)}
          >
            {t("discard")}
          </Button>
        </div>
      )}

      {/* Diff surface */}
      <div className="min-h-0 flex-1">
        {panelMode === "mobile" ? (
          <InlineReviewDiff
            oldContent={review.originalContent}
            newContent={review.proposedContent}
          />
        ) : (
          <DiffEditor
            height="100%"
            language={language}
            theme={monacoTheme(theme)}
            original={review.originalContent}
            modified={review.proposedContent}
            options={{
              readOnly: true,
              renderSideBySide: true,
              automaticLayout: true,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              minimap: { enabled: false },
              fontSize: 13,
            }}
          />
        )}
      </div>

      {/* Hunk list */}
      <div className="border-t">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium">{t("title")}</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            <span className="text-green-600 dark:text-green-400">+{stats.added}</span>{" "}
            <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
          </span>
        </div>
        {total === 0 ? (
          <p className="px-3 pb-3 text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ScrollArea className="max-h-[260px]">
            <div className="space-y-2 px-3 pb-3">
              {review.items.map((item) => (
                <ReviewHunkItem
                  key={item.id}
                  item={item}
                  disabled={isStale}
                  onAccept={(itemId) => setReviewItemStatus(documentId, itemId, "accepted")}
                  onReject={(itemId) => setReviewItemStatus(documentId, itemId, "rejected")}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Badge variant="secondary" className="text-[10px] tabular-nums">
          {t("acceptedCount", { accepted: acceptedCount, total })}
        </Badge>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          onClick={() => rejectCanvasReview(documentId)}
        >
          {t("rejectAll")}
        </Button>
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={isStale || acceptedCount === 0}
          onClick={() => applyCanvasReview(documentId, t("title"))}
        >
          {t("applyAccepted")}
        </Button>
      </div>
    </div>
  )
}

function InlineReviewDiff({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const diff = computeDiff(oldContent, newContent)
  return (
    <ScrollArea className="h-full">
      <pre className="p-2 font-mono text-xs">
        {diff.map((line, i) => (
          <div
            key={i}
            className={cn(
              "px-1",
              line.type === "added" && "bg-green-500/10 text-green-700 dark:text-green-300",
              line.type === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300"
            )}
          >
            <span className="select-none opacity-50">
              {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
            </span>{" "}
            {line.content}
          </div>
        ))}
      </pre>
    </ScrollArea>
  )
}
