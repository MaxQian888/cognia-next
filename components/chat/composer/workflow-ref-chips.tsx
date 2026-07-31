"use client"

// Chips for the workflow graph elements the user referenced for the next
// copilot turn. Mirrors ReferenceChips: reads the chat-store; removing a chip
// drops the reference (which also un-rings the node on the canvas via the chat
// tab's referenced-nodes sync). Staging happens in the composer `@` popover or
// the "reference selection" toolbar action — never here.

import { useTranslations } from "next-intl"
import { BoxIcon, SplineIcon, XIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { Button } from "@/components/ui/button"

export interface WorkflowRefChipsProps {
  /**
   * When true, render only the chips (no padded container) so a parent bar can
   * lay all context chips out in a single flex flow. Defaults to a standalone row.
   */
  bare?: boolean
}

export function WorkflowRefChips({ bare = false }: WorkflowRefChipsProps = {}) {
  const t = useTranslations("chat.composer.workflowRefs")
  const refs = useChatStore((s) => s.referencedWorkflowElements)
  const remove = useChatStore((s) => s.removeReferencedWorkflowElement)

  if (refs.length === 0) return null
  const chips = (
    <>
      {refs.map((r) => {
        const Icon = r.type === "node" ? BoxIcon : SplineIcon
        return (
          <div
            key={`${r.type}-${r.id}`}
            className="group flex items-center gap-1.5 rounded-md border border-violet-400/40 bg-violet-500/5 px-2 py-1 text-xs"
            title={`${r.label} · ${r.kind}`}
            data-testid={`workflow-ref-chip-${r.id}`}
          >
            <Icon className="size-3.5 text-violet-500 dark:text-violet-400" />
            <span className="max-w-[min(220px,calc(100vw-6rem))] truncate font-medium">
              {r.label}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {r.kind}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("removeAria", { label: r.label })}
              onClick={() => remove(r.type, r.id)}
              className="size-5 opacity-60 transition-opacity hover:opacity-100"
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        )
      })}
    </>
  )
  if (bare) return chips
  return <div className="flex flex-wrap gap-1.5 px-2 pt-2">{chips}</div>
}
