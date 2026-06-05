"use client"

// Presentational alias fallback chain: primary entry → fallback → fallback.
// Shared by the alias list rows and the routing test panel.

import { ArrowRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ModelMappingEntry } from "@/types/provider/model-mapping"

interface FallbackChainViewProps {
  entries: ModelMappingEntry[]
  /** Index of the entry to highlight as the current selection (default 0). */
  selectedIndex?: number
}

export function FallbackChainView({ entries, selectedIndex = 0 }: FallbackChainViewProps) {
  if (entries.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="fallback-chain">
      {entries.map((e, i) => (
        <span key={`${e.providerId}:${e.modelId}:${i}`} className="flex items-center gap-1.5">
          {i > 0 ? <ArrowRight className="h-3 w-3 text-muted-foreground" /> : null}
          <Badge
            variant={i === selectedIndex ? "default" : "outline"}
            className="font-mono text-[10px]"
          >
            {e.providerId}:{e.modelId}
            {typeof e.weight === "number" ? ` ×${e.weight}` : ""}
          </Badge>
        </span>
      ))}
    </div>
  )
}

export default FallbackChainView
