"use client"

// Sort dropdown for the workflow library. A radio group of the five sort
// modes; the choice persists through the library store's `sort` field.

import { useTranslations } from "next-intl"
import { ArrowUpDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkflowLibraryStore, type WorkflowSortMode } from "@/stores/workflow"

const SORT_MODES: WorkflowSortMode[] = ["nameAsc", "nameDesc", "updated", "created", "runCount"]

export function WorkflowSortMenu() {
  const t = useTranslations("workflows.library.sort")
  const sort = useWorkflowLibraryStore((s) => s.sort)
  const setSort = useWorkflowLibraryStore((s) => s.setSort)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="workflow-sort-trigger">
          <ArrowUpDownIcon className="size-3.5 mr-1.5" />
          {t("label")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) => setSort(value as WorkflowSortMode)}
        >
          {SORT_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode} data-testid={`workflow-sort-${mode}`}>
              {t(mode)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
