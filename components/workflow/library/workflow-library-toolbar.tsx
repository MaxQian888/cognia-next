"use client"

// Toolbar for the workflow library: debounced search + filter + sort + view
// toggle, plus the "New folder" / "New workflow" actions. The search box keeps
// a local controlled value for responsiveness and writes through to the store
// query on a 200ms trailing debounce so filtering doesn't run every keystroke.

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderPlusIcon, PlusIcon, SearchIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowLibraryViewToggle } from "./workflow-library-view-toggle"
import { WorkflowSortMenu } from "./workflow-sort-menu"
import { WorkflowFilterBar } from "./workflow-filter-bar"

export interface WorkflowLibraryToolbarProps {
  onNewWorkflow: () => void
  onImportFiles: (files: FileList) => void
}

export function WorkflowLibraryToolbar({
  onNewWorkflow,
  onImportFiles,
}: WorkflowLibraryToolbarProps) {
  const t = useTranslations("workflows.library")
  const currentFolderId = useWorkflowLibraryStore((s) => s.currentFolderId)
  const openCreateFolder = useWorkflowLibraryStore((s) => s.openCreateFolder)
  const setQuery = useWorkflowLibraryStore((s) => s.setQuery)
  const storeQuery = useWorkflowLibraryStore((s) => s.query)
  const [text, setText] = useState(storeQuery)
  const { call } = useDebouncedCallback((value: string) => setQuery(value), 200)
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <div className="relative min-w-[200px] flex-1 sm:max-w-md">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            call(e.target.value)
          }}
          placeholder={t("searchPlaceholder")}
          className="pl-9"
          aria-label={t("searchPlaceholder")}
          data-testid="workflow-library-search"
        />
      </div>
      <WorkflowFilterBar />
      <WorkflowSortMenu />
      <WorkflowLibraryViewToggle />
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        multiple
        className="hidden"
        data-testid="workflow-import-input"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onImportFiles(e.target.files)
          e.target.value = "" // allow re-importing the same file
        }}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        data-testid="workflow-import"
      >
        <UploadIcon className="size-4 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("import.button")}</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openCreateFolder(currentFolderId)}
        data-testid="workflow-new-folder"
      >
        <FolderPlusIcon className="size-4 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("newFolder")}</span>
      </Button>
      <Button size="sm" onClick={onNewWorkflow} data-testid="workflow-new">
        <PlusIcon className="size-4 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("new")}</span>
      </Button>
    </div>
  )
}
