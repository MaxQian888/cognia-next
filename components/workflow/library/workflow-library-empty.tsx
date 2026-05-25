"use client"

// Empty-state panel for the workflow library, covering the three distinct
// "nothing to show" cases: an empty library root, an empty folder, and a
// search/filter that matched nothing. Built on the shared `Empty` primitive.

import { useTranslations } from "next-intl"
import { PlusIcon, WorkflowIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export type WorkflowLibraryEmptyVariant = "root" | "folder" | "filtered"

export interface WorkflowLibraryEmptyProps {
  variant: WorkflowLibraryEmptyVariant
  onCreate?: () => void
  onClearFilters?: () => void
}

export function WorkflowLibraryEmpty({
  variant,
  onCreate,
  onClearFilters,
}: WorkflowLibraryEmptyProps) {
  const t = useTranslations("workflows.library.empty")

  const copy =
    variant === "filtered"
      ? { title: t("filterTitle"), description: t("filterDescription") }
      : variant === "folder"
        ? { title: t("folderTitle"), description: t("folderDescription") }
        : { title: t("title"), description: t("description") }

  return (
    <Empty className="mx-auto max-w-md py-12" data-testid={`workflow-empty-${variant}`}>
      <EmptyHeader>
        <EmptyMedia>
          <WorkflowIcon className="size-8" aria-hidden="true" />
        </EmptyMedia>
      </EmptyHeader>
      <EmptyTitle>{copy.title}</EmptyTitle>
      <EmptyDescription>{copy.description}</EmptyDescription>
      {variant === "filtered" ? (
        <Button variant="outline" className="mt-2" onClick={onClearFilters}>
          {t("clearFilters")}
        </Button>
      ) : (
        <Button className="mt-2" onClick={onCreate}>
          <PlusIcon className="size-4 mr-1.5" />
          {t("cta")}
        </Button>
      )}
    </Empty>
  )
}
