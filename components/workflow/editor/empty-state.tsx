"use client"

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
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onAskCopilot ? (
          <button
            type="button"
            onClick={onAskCopilot}
            className="pointer-events-auto rounded-md border bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            data-testid="wf-empty-ask-copilot"
          >
            {t("askCopilot")}
          </button>
        ) : null}
        {onAddNode ? (
          <button
            type="button"
            onClick={onAddNode}
            className="pointer-events-auto rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t("addManualTrigger")}
          </button>
        ) : null}
        <Link
          href="/settings?section=workflows&wfTab=templates"
          className="pointer-events-auto rounded-md border bg-card px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("browseTemplates")}
        </Link>
      </div>
    </Empty>
  )
}
