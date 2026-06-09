"use client"

/**
 * Variable Picker — a popover that browses the current node's upstream outputs
 * as a searchable tree and inserts a `{{ $node['id'].path }}` reference at the
 * cursor (Dify's VarReferencePicker analogue). Only upstream nodes appear, so
 * every inserted reference is in scope by construction. Pairs with the inline
 * invalid-reference linter (B2) which catches manually-typed bad refs.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BracesIcon, SearchIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  buildVariableTree,
  filterVarTree,
  type VarTreeNodeInput,
} from "@/lib/workflow/editor/variable-tree"
import type { GraphEdgeLike } from "@/lib/workflow/editor/upstream-graph"

export interface VariablePickerProps {
  currentNodeId?: string
  nodes: ReadonlyArray<VarTreeNodeInput>
  edges: ReadonlyArray<GraphEdgeLike>
  outputs: Record<string, unknown>
  /** Insert the reference string at the editor cursor. */
  onInsert: (ref: string) => void
  disabled?: boolean
  className?: string
}

export function VariablePicker({
  currentNodeId,
  nodes,
  edges,
  outputs,
  onInsert,
  disabled,
  className,
}: VariablePickerProps) {
  const t = useTranslations("workflows.variablePicker")
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const tree = useMemo(
    () => (currentNodeId ? buildVariableTree(currentNodeId, nodes, edges, outputs) : []),
    [currentNodeId, nodes, edges, outputs]
  )
  const filtered = useMemo(() => filterVarTree(tree, { query }), [tree, query])

  const insert = (ref: string) => {
    onInsert(ref)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40",
          className
        )}
        data-testid="variable-picker-trigger"
        aria-label={t("trigger")}
      >
        <BracesIcon className="size-3" aria-hidden="true" />
        {t("trigger")}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-0"
        data-testid="variable-picker-content"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
          <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            className="h-7 border-0 px-0 text-xs shadow-none focus-visible:ring-0"
            data-testid="variable-picker-search"
          />
        </div>
        <ScrollArea className="max-h-72">
          {filtered.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-xs text-muted-foreground"
              data-testid="variable-picker-empty"
            >
              {t("empty")}
            </div>
          ) : (
            <ul className="py-1">
              {filtered.map((node) => (
                <li key={node.nodeId} className="px-1">
                  <button
                    type="button"
                    onClick={() => insert(node.baseInsert)}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs font-medium hover:bg-accent"
                    data-testid={`variable-picker-node-${node.nodeId}`}
                  >
                    <span className="truncate">{node.label}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-60">
                      {node.kind}
                    </span>
                  </button>
                  {node.fields.map((field) => (
                    <button
                      key={field.path}
                      type="button"
                      onClick={() => insert(field.insert)}
                      className="flex w-full items-center justify-between gap-2 rounded py-0.5 pl-5 pr-2 text-left text-xs hover:bg-accent"
                      data-testid={`variable-picker-field-${node.nodeId}-${field.path}`}
                    >
                      <span className="truncate font-mono">{field.path}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {field.type}
                      </span>
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
