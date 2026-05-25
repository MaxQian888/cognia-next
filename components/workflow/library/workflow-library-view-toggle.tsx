"use client"

// Grid vs list layout toggle for the workflow library. Mirrors
// `components/plugins/library/plugin-library-view-toggle.tsx` — same shadcn
// ToggleGroup primitive, bound to the persisted `viewMode` field on the
// workflow library store so the preference survives reloads.

import { useTranslations } from "next-intl"
import { LayoutGridIcon, ListIcon } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useWorkflowLibraryStore, type WorkflowViewMode } from "@/stores/workflow"

export function WorkflowLibraryViewToggle() {
  const t = useTranslations("workflows.library.view")
  const mode = useWorkflowLibraryStore((s) => s.viewMode)
  const setMode = useWorkflowLibraryStore((s) => s.setViewMode)

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(value) => {
        if (value === "grid" || value === "list") {
          setMode(value as WorkflowViewMode)
        }
      }}
      aria-label={t("toggleAria")}
      data-testid="workflow-library-view-toggle"
    >
      <ToggleGroupItem value="grid" aria-label={t("grid")} data-testid="workflow-view-grid">
        <LayoutGridIcon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem value="list" aria-label={t("list")} data-testid="workflow-view-list">
        <ListIcon className="size-3.5" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
