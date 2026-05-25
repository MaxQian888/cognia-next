"use client"

// Type + status facet filter for the workflow library, packed into a single
// dropdown to keep the toolbar compact. The trigger shows a count badge when
// any non-default filter is active. State lives on the library store's
// `filters` slice (persisted).

import { useTranslations } from "next-intl"
import { ListFilterIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  DEFAULT_WORKFLOW_FILTERS,
  useWorkflowLibraryStore,
  type WorkflowTypeFilter,
} from "@/stores/workflow"

const TYPE_OPTIONS: WorkflowTypeFilter[] = ["all", "user", "template", "builtin"]

const TYPE_LABEL_KEY: Record<WorkflowTypeFilter, string> = {
  all: "typeAll",
  user: "typeUser",
  template: "typeTemplate",
  builtin: "typeBuiltin",
}

export function WorkflowFilterBar() {
  const t = useTranslations("workflows.library.filter")
  const filters = useWorkflowLibraryStore((s) => s.filters)
  const setFilters = useWorkflowLibraryStore((s) => s.setFilters)
  const resetFilters = useWorkflowLibraryStore((s) => s.resetFilters)

  const activeCount =
    (filters.type !== "all" ? 1 : 0) +
    (filters.hasTrigger ? 1 : 0) +
    (filters.recentlyFailed ? 1 : 0)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="workflow-filter-trigger"
          aria-label={t("label")}
        >
          <ListFilterIcon className="size-3.5 mr-1.5" />
          {t("label")}
          {activeCount > 0 ? (
            <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 font-normal">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{t("type")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.type}
          onValueChange={(value) => setFilters({ type: value as WorkflowTypeFilter })}
        >
          {TYPE_OPTIONS.map((opt) => (
            <DropdownMenuRadioItem
              key={opt}
              value={opt}
              data-testid={`workflow-filter-type-${opt}`}
            >
              {t(TYPE_LABEL_KEY[opt])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filters.hasTrigger}
          onCheckedChange={(checked) => setFilters({ hasTrigger: checked === true })}
          data-testid="workflow-filter-has-trigger"
        >
          {t("hasTrigger")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filters.recentlyFailed}
          onCheckedChange={(checked) => setFilters({ recentlyFailed: checked === true })}
          data-testid="workflow-filter-recently-failed"
        >
          {t("recentlyFailed")}
        </DropdownMenuCheckboxItem>
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => resetFilters()} data-testid="workflow-filter-clear">
              {t("clear")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Re-exported so the orchestrator can detect a default filter state cheaply. */
export { DEFAULT_WORKFLOW_FILTERS }
