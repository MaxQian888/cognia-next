"use client"

/**
 * Canvas language / type selector — changes the active document's language and
 * derives its `type` ("text" for Markdown/plain text → Markdown format toolbar,
 * "code" otherwise). Lets the type be set right after creating a document and
 * changed at any time. Bound directly to the artifact store.
 */

import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { CANVAS_LANGUAGE_OPTIONS, canvasTypeForLanguage } from "@/lib/canvas/languages"
import type { ArtifactLanguage } from "@/types/artifact/artifact"

interface CanvasLanguageSelectProps {
  documentId: string | null
  className?: string
}

export function CanvasLanguageSelect({ documentId, className }: CanvasLanguageSelectProps) {
  const t = useTranslations("canvas")
  const doc = useArtifactStore((s) => (documentId ? s.canvasDocuments[documentId] : undefined))
  const updateDoc = useArtifactStore((s) => s.updateCanvasDocument)

  if (!doc) return null

  return (
    <Select
      value={doc.language}
      onValueChange={(value) => {
        const language = value as ArtifactLanguage
        updateDoc(doc.id, {
          language,
          type: canvasTypeForLanguage(language),
          updatedAt: new Date(),
        })
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("language")}
        data-testid="canvas-language-select"
        className={cn("h-7 w-[128px] text-xs", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CANVAS_LANGUAGE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
