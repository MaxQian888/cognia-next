"use client"

/**
 * SourcesPart — collapsible Sources strip rendered under the assistant text.
 * Each item carries an `origin` badge so the user can tell at a glance whether
 * a hit came from Anthropic's Citations API, the Twin RAG store, or a
 * markdown footnote.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { BookIcon, ChevronDownIcon, ExternalLinkIcon } from "lucide-react"
import type { SourcesPart as SourcesPartType, SourcesPartItem } from "@/lib/claude/parts-extensions"

interface SourcesPartProps {
  part: SourcesPartType
  className?: string
  defaultOpen?: boolean
}

const ORIGIN_LABEL: Record<SourcesPartItem["origin"], string> = {
  anthropic: "Web",
  "twin-rag": "Twin",
  footnote: "Note",
}

export function SourcesPart({ part, className, defaultOpen = false }: SourcesPartProps) {
  if (!part.sources || part.sources.length === 0) return null

  return (
    <Collapsible
      data-testid="sources-part"
      className={cn("not-prose my-2 text-primary text-xs", className)}
      defaultOpen={defaultOpen}
    >
      <CollapsibleTrigger className="flex items-center gap-2" data-testid="sources-part-trigger">
        <p className="font-medium">Used {part.sources.length} sources</p>
        <ChevronDownIcon className="h-4 w-4" />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "mt-3 flex w-fit flex-col gap-2",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in"
        )}
      >
        {part.sources.map((s) => (
          <SourceRow key={s.id} source={s} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function SourceRow({ source }: { source: SourcesPartItem }) {
  const body = (
    <div
      className="flex w-full items-start gap-2"
      data-testid="sources-part-row"
      data-source-id={source.id}
    >
      {source.url ? (
        <ExternalLinkIcon
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      ) : (
        <BookIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{source.title}</span>
          <Badge variant="secondary" className="text-[10px]" data-testid="sources-part-origin">
            {ORIGIN_LABEL[source.origin]}
          </Badge>
          {typeof source.score === "number" && (
            <span className="text-[10px] text-muted-foreground" data-testid="sources-part-score">
              {source.score.toFixed(2)}
            </span>
          )}
        </div>
        {source.snippet && (
          <span
            className="line-clamp-2 break-words text-muted-foreground"
            data-testid="sources-part-snippet"
          >
            {source.snippet}
          </span>
        )}
      </div>
    </div>
  )

  if (source.url) {
    return (
      <a
        className="block rounded px-1 py-0.5 hover:bg-muted/60"
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {body}
      </a>
    )
  }
  return <div className="rounded px-1 py-0.5">{body}</div>
}

export default SourcesPart
