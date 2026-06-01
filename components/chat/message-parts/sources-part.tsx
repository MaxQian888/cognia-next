"use client"

/**
 * SourcesPart — collapsible Sources strip rendered under the assistant text.
 * Each item carries an `origin` badge so the user can tell at a glance whether
 * a hit came from Anthropic's Citations API, the Twin RAG store, a Twin style
 * sample, or a markdown footnote. Items with a `chunkRef` (twin-rag) get a
 * "View source" link that deep-links into the Twin workbench.
 */

import { useTranslations } from "next-intl"
import Link from "next/link"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { BookIcon, BrainIcon, ChevronDownIcon, ExternalLinkIcon, SparklesIcon } from "lucide-react"
import type { SourcesPart as SourcesPartType, SourcesPartItem } from "@/lib/claude/parts-extensions"

interface SourcesPartProps {
  part: SourcesPartType
  className?: string
  defaultOpen?: boolean
}

// Map the kebab-case `origin` discriminant to the camelCase `originLabel.*`
// i18n key suffix (next-intl translation key — `chat.sourcesPart.originLabel.*`).
const ORIGIN_LABEL_KEY: Record<SourcesPartItem["origin"], string> = {
  anthropic: "anthropic",
  "twin-rag": "twinRag",
  "twin-style": "twinStyle",
  memory: "memory",
  footnote: "footnote",
}

// Origins that are "retrieval feedback" worth auto-expanding when they're the
// only thing shown (twin chunks/style + recalled memory).
const AUTO_OPEN_ORIGINS: SourcesPartItem["origin"][] = ["twin-rag", "twin-style", "memory"]

function isOnlyRetrieval(sources: SourcesPartItem[]): boolean {
  return sources.length > 0 && sources.every((s) => AUTO_OPEN_ORIGINS.includes(s.origin))
}

function partition(sources: SourcesPartItem[]) {
  const twinRag: SourcesPartItem[] = []
  const twinStyle: SourcesPartItem[] = []
  const memory: SourcesPartItem[] = []
  const other: SourcesPartItem[] = []
  for (const s of sources) {
    if (s.origin === "twin-rag") twinRag.push(s)
    else if (s.origin === "twin-style") twinStyle.push(s)
    else if (s.origin === "memory") memory.push(s)
    else other.push(s)
  }
  return { twinRag, twinStyle, memory, other }
}

export function SourcesPart({ part, className, defaultOpen }: SourcesPartProps) {
  const t = useTranslations("chat.sourcesPart")
  if (!part.sources || part.sources.length === 0) return null

  // Default-open when the only sources are twin-* so the user discovers the
  // retrieval feedback without an extra click. Explicit prop wins.
  const open = defaultOpen ?? isOnlyRetrieval(part.sources)
  const { twinRag, twinStyle, memory, other } = partition(part.sources)

  return (
    <Collapsible
      data-testid="sources-part"
      className={cn("not-prose my-2 text-primary text-xs", className)}
      defaultOpen={open}
    >
      <CollapsibleTrigger className="flex items-center gap-2" data-testid="sources-part-trigger">
        <p className="font-medium">{t("usedSources", { count: part.sources.length })}</p>
        <ChevronDownIcon className="h-4 w-4" />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "mt-3 flex w-fit flex-col gap-3",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in"
        )}
      >
        {twinRag.length > 0 && (
          <section className="flex flex-col gap-2" data-testid="sources-part-section-twin-rag">
            <h4 className="text-[11px] font-medium text-muted-foreground">
              {t("retrievedChunksHeader", { count: twinRag.length })}
            </h4>
            <div className="flex flex-col gap-1">
              {twinRag.map((s) => (
                <SourceRow key={s.id} source={s} />
              ))}
            </div>
          </section>
        )}
        {twinStyle.length > 0 && (
          <section className="flex flex-col gap-2" data-testid="sources-part-section-twin-style">
            <h4 className="text-[11px] font-medium text-muted-foreground">
              {t("styleSamplesHeader", { count: twinStyle.length })}
            </h4>
            <div className="flex flex-col gap-1">
              {twinStyle.map((s) => (
                <SourceRow key={s.id} source={s} />
              ))}
            </div>
          </section>
        )}
        {memory.length > 0 && (
          <section className="flex flex-col gap-2" data-testid="sources-part-section-memory">
            <h4 className="text-[11px] font-medium text-muted-foreground">
              {t("recalledMemoriesHeader", { count: memory.length })}
            </h4>
            <div className="flex flex-col gap-1">
              {memory.map((s) => (
                <SourceRow key={s.id} source={s} />
              ))}
            </div>
          </section>
        )}
        {other.length > 0 && (
          <section className="flex flex-col gap-1" data-testid="sources-part-section-other">
            {other.map((s) => (
              <SourceRow key={s.id} source={s} />
            ))}
          </section>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function originIcon(origin: SourcesPartItem["origin"]) {
  if (origin === "twin-style") {
    return (
      <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    )
  }
  if (origin === "memory") {
    return (
      <BrainIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    )
  }
  return <BookIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
}

function buildTwinDeepLink(ref: NonNullable<SourcesPartItem["chunkRef"]>): string {
  const params = new URLSearchParams({
    twinId: ref.twinId,
    tab: "sources",
    sourceId: ref.sourceId,
    chunkId: ref.chunkId,
  })
  return `/twin?${params.toString()}`
}

function SourceRow({ source }: { source: SourcesPartItem }) {
  const t = useTranslations("chat.sourcesPart")
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
        originIcon(source.origin)
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{source.title}</span>
          <Badge variant="secondary" className="text-[10px]" data-testid="sources-part-origin">
            {t(`originLabel.${ORIGIN_LABEL_KEY[source.origin]}`)}
          </Badge>
          {typeof source.score === "number" && (
            <span className="text-[10px] text-muted-foreground" data-testid="sources-part-score">
              {source.score.toFixed(2)}
            </span>
          )}
          {source.chunkRef && (
            <Link
              href={buildTwinDeepLink(source.chunkRef)}
              className="ml-auto text-[10px] text-muted-foreground hover:text-primary"
              data-testid="sources-part-view-source"
            >
              {t("viewSource")}
            </Link>
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
