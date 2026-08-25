"use client"

/**
 * ArtifactReviewView - Codex-style review surface for an AI-revision proposal.
 *
 * Top: a Monaco DiffEditor (current vs proposed) on desktop, or a compact
 * inline diff on mobile (Monaco is desktop-gated in the artifact panel). Below
 * it, a per-hunk accept/reject list and an apply/reject footer. When the
 * proposal's baseline has moved (a manual edit or restore happened mid-review)
 * a stale banner offers re-diff or discard.
 */

import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useMonacoActiveTheme } from "@/hooks/git/use-monaco-active-theme"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { computeDiff, computeDiffStats, getMonacoLanguage } from "@/lib/artifacts"
import { cn } from "@/lib/utils"
import { ReviewHunkItem } from "./review-hunk-item"
import type { Artifact } from "@/types"

const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full p-4 space-y-2">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ),
})

interface ArtifactReviewViewProps {
  artifact: Artifact
  /** "mobile" swaps the Monaco DiffEditor for a lightweight inline diff. */
  panelMode: "desktop" | "tablet" | "mobile" | "fullscreen"
}

export function ArtifactReviewView({ artifact, panelMode }: ArtifactReviewViewProps) {
  // ADR-0148 — the app's own Monaco theme, not stock VS Code.
  const { themeId, registerMonaco } = useMonacoActiveTheme()
  const t = useTranslations("artifacts.review")

  const review = useArtifactStore((state) => state.pendingReviews[artifact.id] ?? null)
  const setReviewItemStatus = useArtifactStore((state) => state.setReviewItemStatus)
  const applyArtifactReview = useArtifactStore((state) => state.applyArtifactReview)
  const rejectArtifactReview = useArtifactStore((state) => state.rejectArtifactReview)
  const proposeArtifactUpdate = useArtifactStore((state) => state.proposeArtifactUpdate)

  // No proposal pending. This panel is permanently registered on the artifact
  // surface, so the Review activity can be reached at any time — returning null
  // handed the user a blank panel with no explanation of what it was for.
  // Deliberately not `ContextCapabilityUnavailable`: nothing is unavailable
  // here, there is simply nothing to review yet.
  if (!review) {
    return (
      <div
        data-testid="artifact-review-empty"
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      >
        <p className="text-sm font-medium">{t("empty")}</p>
        <p className="text-xs text-muted-foreground">{t("emptyDescription")}</p>
      </div>
    )
  }

  const stats = computeDiffStats(computeDiff(review.originalContent, review.proposedContent))
  const acceptedCount = review.items.filter((item) => item.status === "accepted").length
  const total = review.items.length
  const isStale = review.isStale === true

  return (
    <div data-testid="artifact-review-view" className="flex h-full min-h-0 flex-col">
      {isStale && (
        <div
          data-testid="review-stale-banner"
          className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{t("staleBanner")}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => proposeArtifactUpdate(artifact.id, review.proposedContent)}
          >
            {t("reDiff")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => rejectArtifactReview(artifact.id)}
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
            language={getMonacoLanguage(artifact.language || "plaintext")}
            theme={themeId}
            onMount={(_editor, monaco) => registerMonaco(monaco)}
            original={review.originalContent}
            modified={review.proposedContent}
            options={{
              readOnly: true,
              renderSideBySide: panelMode !== "tablet",
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
                  onAccept={(itemId) => setReviewItemStatus(artifact.id, itemId, "accepted")}
                  onReject={(itemId) => setReviewItemStatus(artifact.id, itemId, "rejected")}
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
          onClick={() => rejectArtifactReview(artifact.id)}
        >
          {t("rejectAll")}
        </Button>
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={isStale || acceptedCount === 0}
          onClick={() => applyArtifactReview(artifact.id, t("title"))}
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
