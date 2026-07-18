"use client"

// Header action for the Edit/Write tool cards: routes the touched file into the
// project-file Context Workbench's git-review surface. Renders nothing unless a
// session is known and a filesystem backend is available (so it is inert in
// pure web mode rather than dangling as a dead control).

import { useTranslations } from "next-intl"
import { GitCompareArrowsIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { canOfferWorkbenchReview, openEditInWorkbenchReview } from "@/lib/files/edit-review-bridge"

export function WorkbenchReviewButton({
  sessionId,
  absolutePath,
}: {
  sessionId?: string
  absolutePath: string
}) {
  const t = useTranslations("chat.mcp")
  if (!sessionId || !canOfferWorkbenchReview()) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-6"
      aria-label={t("openInReview")}
      title={t("openInReview")}
      data-testid="mcp-open-in-review"
      onClick={() => void openEditInWorkbenchReview({ sessionId, absolutePath })}
    >
      <GitCompareArrowsIcon className="size-3.5" />
    </Button>
  )
}
