"use client"

/**
 * Mobile workflow-library toolbar. Surfaces the search / sort / filter / view
 * controls the desktop library already has — all reading the SAME
 * `useWorkflowLibraryStore` slice — plus a row-density toggle and the new
 * folder / workflow actions. No new state layer: it reuses `WorkflowSortMenu`
 * and `WorkflowFilterBar` verbatim (Radix dropdowns are touch-friendly).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderPlusIcon, PlusIcon, Rows2Icon, Rows3Icon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowSortMenu } from "@/components/workflow/library/workflow-sort-menu"
import { WorkflowFilterBar } from "@/components/workflow/library/workflow-filter-bar"
import { useMobileWorkflowView } from "./use-mobile-workflow-view"

export interface WorkflowListToolbarProps {
  onNewWorkflow: () => void
}

export function WorkflowListToolbar({ onNewWorkflow }: WorkflowListToolbarProps) {
  const t = useTranslations("mobile.workflow")
  const tLib = useTranslations("workflows.library")
  const currentFolderId = useWorkflowLibraryStore((s) => s.currentFolderId)
  const openCreateFolder = useWorkflowLibraryStore((s) => s.openCreateFolder)
  const setQuery = useWorkflowLibraryStore((s) => s.setQuery)
  const storeQuery = useWorkflowLibraryStore((s) => s.query)
  const [text, setText] = useState(storeQuery)
  const { call } = useDebouncedCallback((value: string) => setQuery(value), 200)
  const { view, toggle } = useMobileWorkflowView()

  return (
    <div className="flex flex-col gap-2 px-4" data-testid="mobile-workflow-toolbar">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            call(e.target.value)
          }}
          placeholder={tLib("searchPlaceholder")}
          aria-label={tLib("searchPlaceholder")}
          className="pl-9"
          data-testid="mobile-workflow-search"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <WorkflowSortMenu />
        <WorkflowFilterBar />
        <Button
          variant="outline"
          size="sm"
          onClick={() => toggle()}
          aria-label={t(view === "compact" ? "density.comfortable" : "density.compact")}
          data-testid="mobile-workflow-density"
        >
          {view === "compact" ? (
            <Rows3Icon className="size-4" />
          ) : (
            <Rows2Icon className="size-4" />
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openCreateFolder(currentFolderId)}
          data-testid="mobile-workflow-new-folder"
        >
          <FolderPlusIcon className="size-4" />
        </Button>
        <Button size="sm" onClick={onNewWorkflow} data-testid="mobile-workflow-new">
          <PlusIcon className="size-4" />
        </Button>
      </div>
    </div>
  )
}
