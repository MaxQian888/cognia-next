"use client"

/**
 * SuggestionsPanel - Displays AI-generated suggestions for Canvas documents
 */

import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useArtifactStore } from "@/stores"
import { SuggestionItem } from "./suggestion-item"
import type { CanvasSuggestion } from "@/types"

interface SuggestionsPanelProps {
  documentId: string
  suggestions: CanvasSuggestion[]
  isGenerating?: boolean
  proposalFirst?: boolean
}

export function SuggestionsPanel({
  documentId,
  suggestions,
  isGenerating = false,
  proposalFirst = false,
}: SuggestionsPanelProps) {
  const t = useTranslations("canvas")
  const applySuggestion = useArtifactStore((state) => state.applySuggestion)
  const updateSuggestionStatus = useArtifactStore((state) => state.updateSuggestionStatus)
  const proposeCanvasReview = useArtifactStore((state) => state.proposeCanvasReview)
  const document = useArtifactStore((state) => state.canvasDocuments[documentId])

  const apply = (suggestion: CanvasSuggestion) => {
    if (!proposalFirst || !document) {
      applySuggestion(documentId, suggestion.id)
      return
    }
    const lines = document.content.split("\n")
    const proposedContent = [
      ...lines.slice(0, suggestion.range.startLine),
      suggestion.suggestedText,
      ...lines.slice(suggestion.range.endLine + 1),
    ].join("\n")
    const review = proposeCanvasReview(documentId, proposedContent, {
      requestId: suggestion.id,
      actionType: "improve",
    })
    if (review) updateSuggestionStatus(documentId, suggestion.id, "accepted")
  }

  const pendingSuggestions = suggestions.filter((s) => s.status === "pending")

  if (pendingSuggestions.length === 0 && !isGenerating) return null

  return (
    <div className="border-t">
      <div className="px-4 py-2 text-sm font-medium flex items-center gap-2">
        {isGenerating ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("generatingSuggestions")}
          </>
        ) : (
          <>
            {t("aiSuggestions")} ({pendingSuggestions.length})
          </>
        )}
      </div>
      <ScrollArea className="max-h-[200px]">
        <div className="space-y-2 px-4 pb-4">
          {pendingSuggestions.map((suggestion) => (
            <SuggestionItem
              key={suggestion.id}
              suggestion={suggestion}
              onApply={() => apply(suggestion)}
              onReject={(id) => updateSuggestionStatus(documentId, id, "rejected")}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
