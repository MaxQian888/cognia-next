"use client"

// Toolbar for the workflow library: debounced search + filter + sort + view
// toggle, plus the "New folder" and import actions. The search box keeps
// a local controlled value for responsiveness and writes through to the store
// query on a 200ms trailing debounce so filtering doesn't run every keystroke.

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderPlusIcon, SearchIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowLibraryViewToggle } from "./workflow-library-view-toggle"
import { WorkflowSortMenu } from "./workflow-sort-menu"
import { WorkflowFilterBar } from "./workflow-filter-bar"

export interface WorkflowLibraryToolbarProps {
  onImportFiles: (files: FileList) => void
}

export function WorkflowLibraryToolbar({ onImportFiles }: WorkflowLibraryToolbarProps) {
  const t = useTranslations("workflows.library")
  const currentFolderId = useWorkflowLibraryStore((s) => s.currentFolderId)
  const openCreateFolder = useWorkflowLibraryStore((s) => s.openCreateFolder)
  const setQuery = useWorkflowLibraryStore((s) => s.setQuery)
  const storeQuery = useWorkflowLibraryStore((s) => s.query)
  const [text, setText] = useState(storeQuery)
  const { call } = useDebouncedCallback((value: string) => setQuery(value), 200)
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex min-w-[min(100%,28rem)] flex-1 flex-wrap items-center justify-end gap-2">
      <div className="relative min-w-56 flex-[1_1_18rem] 2xl:max-w-md">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            call(e.target.value)
          }}
          placeholder={t("searchPlaceholder")}
          className="h-8 bg-background/80 pl-9 shadow-xs"
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
        aria-label={t("import.button")}
        data-testid="workflow-import"
      >
        <UploadIcon className="size-4 2xl:mr-1.5" />
        <span className="hidden 2xl:inline">{t("import.button")}</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openCreateFolder(currentFolderId)}
        aria-label={t("newFolder")}
        data-testid="workflow-new-folder"
      >
        <FolderPlusIcon className="size-4 2xl:mr-1.5" />
        <span className="hidden 2xl:inline">{t("newFolder")}</span>
      </Button>
    </div>
  )
}
