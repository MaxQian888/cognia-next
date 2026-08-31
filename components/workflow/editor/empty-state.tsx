"use client"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { WorkflowIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"

export function EditorEmptyState({
  onAddNode,
  onAskCopilot,
}: {
  onAddNode?: () => void
  /** Open the AI panel. Natural-language authoring had no entry point here. */
  onAskCopilot?: () => void
}) {
  const t = useTranslations("workflows.empty")
  return (
    <Empty className="absolute inset-0 m-auto h-fit max-w-md pointer-events-none">
      <EmptyHeader>
        <EmptyMedia>
          <WorkflowIcon className="size-8" aria-hidden="true" />
        </EmptyMedia>
      </EmptyHeader>
      <EmptyTitle>{t("title")}</EmptyTitle>
      <EmptyDescription>{t("description")}</EmptyDescription>
      {/* The shared Button rather than three hand-rolled ones: each carried its
          own radius, border and tint, which is exactly what ADR-0148 counts as
          a bare panel. `pointer-events-auto` because the Empty above is
          click-through so the canvas stays usable underneath. */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onAskCopilot ? (
          <Button
            type="button"
            size="sm"
            onClick={onAskCopilot}
            className="pointer-events-auto"
            data-testid="wf-empty-ask-copilot"
          >
            {t("askCopilot")}
          </Button>
        ) : null}
        {onAddNode ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAddNode}
            className="pointer-events-auto"
          >
            {t("addManualTrigger")}
          </Button>
        ) : null}
        <Button asChild size="sm" variant="ghost" className="pointer-events-auto">
          <Link href="/settings?section=workflows&wfTab=templates">{t("browseTemplates")}</Link>
        </Button>
      </div>
    </Empty>
  )
}
