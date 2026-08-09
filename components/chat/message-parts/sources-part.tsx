"use client"

/**
 * SourcesPart — collapsible Sources strip rendered under the assistant text.
 * Each item carries an `origin` badge so the user can tell at a glance whether
 * a hit came from Anthropic's Citations API, the Twin RAG store, a Twin style
 * sample, or a markdown footnote. Items with a `chunkRef` (twin-rag) get a
 * "View source" link that deep-links into the Twin workbench.
 */

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationSource,
  InlineCitationText,
} from "@/components/ai-elements/inline-citation"
import { Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { ExternalLink } from "@/components/shared/external-link"
import {
  AlertTriangleIcon,
  BookIcon,
  BrainIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  SparklesIcon,
} from "lucide-react"
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
  "agent-knowledge-base": "agentKnowledgeBase",
  memory: "memory",
  footnote: "footnote",
}

// Origins that are "retrieval feedback" worth auto-expanding when they're the
// only thing shown (twin chunks/style + recalled memory).
const AUTO_OPEN_ORIGINS: SourcesPartItem["origin"][] = [
  "twin-rag",
  "twin-style",
  "agent-knowledge-base",
  "memory",
]

function isOnlyRetrieval(sources: SourcesPartItem[]): boolean {
  return sources.length > 0 && sources.every((s) => AUTO_OPEN_ORIGINS.includes(s.origin))
}

function partition(sources: SourcesPartItem[]) {
  const twinRag: SourcesPartItem[] = []
  const twinStyle: SourcesPartItem[] = []
  const memory: SourcesPartItem[] = []
  const agentKnowledge: SourcesPartItem[] = []
  const other: SourcesPartItem[] = []
  for (const s of sources) {
    if (s.origin === "twin-rag") twinRag.push(s)
    else if (s.origin === "twin-style") twinStyle.push(s)
    else if (s.origin === "memory") memory.push(s)
    else if (s.origin === "agent-knowledge-base") agentKnowledge.push(s)
    else other.push(s)
  }
  return { twinRag, twinStyle, agentKnowledge, memory, other }
}

export function SourcesPart({ part, className, defaultOpen }: SourcesPartProps) {
  const t = useTranslations("chat.sourcesPart")
  // Both the retrieval-only check (a `.every` pass) and the partition (an O(n)
  // bucketing that allocates four arrays) only depend on the sources array;
  // memoize them so unrelated parent re-renders don't repeat the work.
  const isRetrievalOnly = useMemo(() => isOnlyRetrieval(part.sources ?? []), [part.sources])
  const buckets = useMemo(() => partition(part.sources ?? []), [part.sources])
  const hasSources = Boolean(part.sources && part.sources.length > 0)
  // A degraded twin turn must still render — the warning is the point — even
  // when retrieval came back empty.
  if (!hasSources && !part.twinDegraded) return null

  const degradedNotice = part.twinDegraded ? (
    <div
      data-testid="sources-part-degraded"
      role="status"
      className="not-prose my-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
    >
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{t("degradedNotice")}</span>
    </div>
  ) : null

  // Degraded with no retrieved sources → the notice is all there is to show.
  if (!hasSources) return degradedNotice

  // Default-open when the only sources are twin-* so the user discovers the
  // retrieval feedback without an extra click. Explicit prop wins.
  const open = defaultOpen ?? isRetrievalOnly
  const { twinRag, twinStyle, agentKnowledge, memory, other } = buckets

  return (
    <>
      {degradedNotice}
      <Sources
        data-testid="sources-part"
        className={cn("not-prose my-2 text-primary text-xs", className)}
        defaultOpen={open}
      >
        <SourcesTrigger
          count={part.sources.length}
          className="group flex items-center gap-2 rounded-sm transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          data-testid="sources-part-trigger"
        >
          <p className="font-medium">{t("usedSources", { count: part.sources.length })}</p>
          <ChevronDownIcon className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </SourcesTrigger>
        <SourcesContent
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
          {agentKnowledge.length > 0 && (
            <section
              className="flex flex-col gap-2"
              data-testid="sources-part-section-agent-knowledge-base"
            >
              <h4 className="text-[11px] font-medium text-muted-foreground">
                {t("agentKnowledgeHeader", { count: agentKnowledge.length })}
              </h4>
              <div className="flex flex-col gap-1">
                {agentKnowledge.map((source) => (
                  <SourceRow key={source.id} source={source} />
                ))}
              </div>
            </section>
          )}
          {other.length > 0 && (
            <section className="flex flex-col gap-1" data-testid="sources-part-section-other">
              <WebCitations sources={other} />
              {other.map((s) => (
                <SourceRow key={s.id} source={s} />
              ))}
            </section>
          )}
        </SourcesContent>
      </Sources>
    </>
  )
}

// Only absolute http(s) URLs are safe to feed the citation trigger, which
// constructs `new URL(...)` to show the hostname.
const ABSOLUTE_URL_RE = /^https?:\/\//i

// Summarize the web/footnote sources (those carrying a URL) as a single
// inline-citation badge whose hover-card flips through each source's
// title/url/snippet. Additive to the per-source rows below — nothing renders
// when none of the "other" sources have a usable URL (e.g. plain footnotes).
const WebCitations = memo(function WebCitations({ sources }: { sources: SourcesPartItem[] }) {
  const t = useTranslations("chat.sourcesPart")
  const webSources = useMemo(
    () => sources.filter((s) => s.url && ABSOLUTE_URL_RE.test(s.url)),
    [sources]
  )
  if (webSources.length === 0) return null
  const urls = webSources.map((s) => s.url as string)

  return (
    <InlineCitation className="mb-1" data-testid="sources-part-inline-citation">
      <InlineCitationText className="text-[11px] font-medium text-muted-foreground">
        {t("citationsLabel", { count: webSources.length })}
      </InlineCitationText>
      <InlineCitationCard>
        <InlineCitationCardTrigger sources={urls} />
        <InlineCitationCardBody>
          <InlineCitationCarousel>
            <InlineCitationCarouselHeader>
              <InlineCitationCarouselPrev />
              <InlineCitationCarouselNext />
              <InlineCitationCarouselIndex />
            </InlineCitationCarouselHeader>
            <InlineCitationCarouselContent>
              {webSources.map((s) => (
                <InlineCitationCarouselItem key={s.id}>
                  <InlineCitationSource title={s.title} url={s.url} description={s.snippet} />
                </InlineCitationCarouselItem>
              ))}
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  )
})

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

const SourceRow = memo(function SourceRow({ source }: { source: SourcesPartItem }) {
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
      <ExternalLink
        className="block rounded px-1 py-0.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        href={source.url}
      >
        {body}
      </ExternalLink>
    )
  }
  return <div className="rounded px-1 py-0.5">{body}</div>
})

export default SourcesPart
