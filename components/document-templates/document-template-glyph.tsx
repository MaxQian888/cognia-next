"use client"

/**
 * The picture on a document template card (ADR-0223): a glyph per built-in,
 * a plus for the blank page and a bookmark for the ones people saved. Purely
 * decorative — the card's name is its accessible name.
 */

import {
  BookOpenIcon,
  BookmarkIcon,
  CalendarCheckIcon,
  ListChecksIcon,
  NotebookPenIcon,
  PlusIcon,
  TrendingUpIcon,
  type LucideIcon,
} from "lucide-react"

import type { DocumentTemplateIcon } from "@/lib/document-templates/builtin"
import { cn } from "@/lib/utils"

export const DOCUMENT_TEMPLATE_GLYPHS: Record<DocumentTemplateIcon, LucideIcon> = {
  blank: PlusIcon,
  guide: BookOpenIcon,
  todo: ListChecksIcon,
  tracker: TrendingUpIcon,
  update: CalendarCheckIcon,
  meeting: NotebookPenIcon,
  saved: BookmarkIcon,
}

export function DocumentTemplateGlyph({
  icon,
  className,
}: {
  icon: DocumentTemplateIcon
  className?: string
}) {
  const Glyph = DOCUMENT_TEMPLATE_GLYPHS[icon]
  return (
    <Glyph
      className={cn("size-5 shrink-0", className)}
      aria-hidden
      data-testid="document-template-glyph"
      data-icon={icon}
    />
  )
}
