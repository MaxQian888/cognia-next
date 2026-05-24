"use client"

import { useState } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight } from "lucide-react"

export interface JsonTreeProps {
  value: unknown
  depth?: number
  className?: string
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="text-chart-2">&quot;{value}&quot;</span>
  }
  if (typeof value === "number") {
    return <span className="text-chart-3">{value}</span>
  }
  if (typeof value === "boolean") {
    return <span className="text-chart-1">{String(value)}</span>
  }
  if (value === null) {
    return <span className="text-chart-1">null</span>
  }
  return <span>{String(value)}</span>
}

export function JsonTree({
  label,
  value,
  depth = 0,
  defaultExpanded = depth === 0,
}: {
  label?: string
  value: unknown
  depth?: number
  defaultExpanded?: boolean
}) {
  const isArray = Array.isArray(value)
  const isObject = value !== null && typeof value === "object" && !isArray
  const entries = isArray
    ? (value as unknown[]).map((entry, index) => [String(index), entry] as const)
    : isObject
      ? Object.entries(value as Record<string, unknown>)
      : []
  const isCollapsible = isArray || isObject
  const [open, setOpen] = useState(defaultExpanded)

  if (!isCollapsible) {
    return (
      <div className="font-mono text-xs leading-5" style={{ paddingLeft: depth * 12 }}>
        {label ? (
          <>
            <span className="text-chart-4">&quot;{label}&quot;</span>
            <span>: </span>
          </>
        ) : null}
        <JsonPrimitive value={value} />
      </div>
    )
  }

  const wrapperOpen = isArray ? "[" : "{"
  const wrapperClose = isArray ? "]" : "}"

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div style={{ paddingLeft: depth * 12 }}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-mono hover:text-foreground">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {label ? <span className="text-chart-4">&quot;{label}&quot;:</span> : null}
          <span>{wrapperOpen}</span>
          <span className="text-muted-foreground">{entries.length}</span>
          <span className="text-muted-foreground">{isArray ? "items" : "keys"}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1 pt-1">
          {entries.map(([entryLabel, entryValue]) => (
            <JsonTree
              key={`${label || "root"}-${entryLabel}`}
              label={isArray ? `[${entryLabel}]` : entryLabel}
              value={entryValue}
              depth={depth + 1}
              defaultExpanded={depth === 0}
            />
          ))}
          <div
            className="font-mono text-xs leading-5 text-muted-foreground"
            style={{ paddingLeft: 12 }}
          >
            {wrapperClose}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
