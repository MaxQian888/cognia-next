"use client"

/**
 * In-canvas Spotlight search overlay. Ctrl/Cmd+F opens it, typing any
 * substring of a node label / kind / sticky-note text filters, and
 * Enter or a click pans the viewport to the chosen node and triggers a
 * brief pulse highlight (3 s, gated by the resolved performance tier).
 *
 * Distinct from the Cmd+K command palette: spotlight is canvas-scoped
 * (only nodes on the current workflow, no editor actions).
 *
 * The rows, the group breadcrumb and the reveal live in `useNodeSpotlight`,
 * because the phone has the same search and none of this chrome. What stays
 * here is the CommandDialog and cmdk's own filtering, which is why the query
 * lives in this component and not in the hook.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { ReactFlowInstance } from "@xyflow/react"
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { getNodeIcon } from "@/lib/workflow/editor/node-icons"
import { useNodeSpotlight } from "@/lib/workflow/editor/use-node-spotlight"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export interface SpotlightSearchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  store: EditorStore
  reactFlowInstance: ReactFlowInstance | null
  /** When false, viewport jump and pulse skip animation entirely. */
  animationsEnabled: boolean
}

export function SpotlightSearch({
  open,
  onOpenChange,
  store,
  reactFlowInstance,
  animationsEnabled,
}: SpotlightSearchProps) {
  const t = useTranslations("workflows.editor.spotlight")
  const [query, setQuery] = useState("")
  const { filterRows, reveal } = useNodeSpotlight({
    store,
    reactFlowInstance,
    animationsEnabled,
  })

  const filteredRows = filterRows(query)

  const handleSelect = (rowId: string) => {
    reveal(rowId)
    onOpenChange(false)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("openShortcut")}
      description={t("placeholder")}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("placeholder")}
        data-testid="spotlight-input"
      />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>
        {filteredRows.map((r) => {
          const Icon = getNodeIcon(r.kind as WorkflowNodeKind)
          return (
            <CommandItem
              key={r.id}
              value={r.value}
              onSelect={() => handleSelect(r.id)}
              data-testid={`spotlight-row-${r.id}`}
            >
              <Icon className="size-4 shrink-0 mr-2" aria-hidden="true" />
              <span className="flex-1 truncate">{r.label}</span>
              {r.groupLabel ? (
                <span
                  className="ml-2 text-xs text-muted-foreground truncate max-w-[120px]"
                  data-testid={`spotlight-breadcrumb-${r.id}`}
                >
                  {t("breadcrumbIn", { group: r.groupLabel })}
                </span>
              ) : null}
              <span className="ml-2 text-[10px] uppercase opacity-70">{r.kind}</span>
            </CommandItem>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
