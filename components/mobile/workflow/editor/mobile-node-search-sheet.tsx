"use client"

/**
 * Find a node on this canvas, from a phone.
 *
 * The desktop has had canvas-scoped search since Spotlight shipped, reachable
 * only by Ctrl/Cmd+F. On a touch device that shortcut does not exist, and a
 * graph big enough to need searching is exactly the graph a phone cannot pan
 * around by eye, so the one surface that needed it most was the one without it.
 *
 * The rows, the group breadcrumb and the reveal come from `useNodeSpotlight`,
 * the same hook the desktop dialog uses. What differs is the shell: a bottom
 * sheet with a real `<input>` and thumb-sized rows, rather than a cmdk dialog
 * driven by arrow keys.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Surface } from "@/components/surface/surface"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { getNodeIcon } from "@/lib/workflow/editor/node-icons"
import type { EditorStore } from "@/lib/workflow/editor/store"
import {
  useNodeSpotlight,
  type SpotlightViewport,
} from "@/lib/workflow/editor/use-node-spotlight"

export interface MobileNodeSearchSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  store: EditorStore
  reactFlowInstance: SpotlightViewport | null
  /**
   * Called after a row reveals its node, so the editor can bring up the
   * inspector for it. The reveal itself already centres, selects and pulses.
   */
  onReveal?: (nodeId: string) => void
}

export function MobileNodeSearchSheet({
  open,
  onOpenChange,
  store,
  reactFlowInstance,
  onReveal,
}: MobileNodeSearchSheetProps) {
  const t = useTranslations("workflows.editor.spotlight")
  const [query, setQuery] = useState("")
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))

  // The pulse is a 3 s highlight on a node the user is about to look at, so it
  // runs whatever the perf tier says. The phone's own tier gates the canvas
  // animations, not this one confirmation that the jump landed somewhere.
  const { filterRows, reveal } = useNodeSpotlight({
    store,
    reactFlowInstance,
    animationsEnabled: true,
  })

  const rows = filterRows(query)

  const select = (nodeId: string) => {
    reveal(nodeId)
    onOpenChange(false)
    setQuery("")
    onReveal?.(nodeId)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // Same clamp as the palette sheet: a flat 80vh overflows on a short or
        // notched device in the wide-axis orientation this editor defaults to.
        className="h-[80vh] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-2rem)] gap-0 p-0"
        data-testid="mobile-node-search"
        aria-describedby={undefined}
      >
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm">{t("openShortcut")}</SheetTitle>
        </SheetHeader>
        <div className="relative shrink-0 p-3">
          <SearchIcon
            className="absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("placeholder")}
            aria-label={t("placeholder")}
            className="pl-9"
            data-testid="mobile-node-search-input"
          />
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-6">
          {rows.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            rows.map((row) => {
              const Icon = getNodeIcon(row.kind)
              return (
                <Surface key={row.id} asChild layer="raised" radius="control">
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-2 p-2.5 text-left"
                    onClick={() => select(row.id)}
                    data-testid={`mobile-node-search-row-${row.id}`}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm">{row.label}</span>
                    {row.groupLabel ? (
                      <span
                        className="max-w-[40%] shrink truncate text-xs text-muted-foreground"
                        data-testid={`mobile-node-search-breadcrumb-${row.id}`}
                      >
                        {t("breadcrumbIn", { group: row.groupLabel })}
                      </span>
                    ) : null}
                  </button>
                </Surface>
              )
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
