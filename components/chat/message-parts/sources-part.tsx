"use client"

/**
 * SourcesPart — collapsible Sources strip rendered under the assistant text.
 * Each item carries an `origin` badge so the user can tell at a glance whether
 * a hit came from Anthropic's Citations API, the Twin RAG store, a Twin style
 * sample, or a markdown footnote. Items with a `chunkRef` (twin-rag) get a
 * "View source" link that deep-links into the Twin workbench.
 */

import { memo, useCallback, useMemo, useState } from "react"
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
import { toast } from "sonner"
import {
  AlertTriangleIcon,
  BookIcon,
  BrainIcon,
  ChevronDownIcon,
  ClockAlertIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
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
  "cognia-web": "cogniaWeb",
  "twin-rag": "twinRag",
  "twin-style": "twinStyle",
  "agent-knowledge-base": "agentKnowledgeBase",
  "project-knowledge": "projectKnowledge",
  "project-claim": "projectClaim",
  "project-history": "projectHistory",
  memory: "memory",
  footnote: "footnote",
}

/**
 * One grouped section per origin, in render order.
 *
 * A TABLE, not another `<section>` block. The five hand-written blocks this
 * replaced were near-identical, and the partition beside them was a matching
 * if-else chain — so every new origin meant editing two parallel lists and
 * pasting a sixth copy of the same markup. `data-testid` was already systematic
 * (`sources-part-section-<origin>`), which is what makes the table a drop-in.
 *
 * Order mirrors the system prompt: personal facts, then what was mined about the
 * workspace, then what was searched for, then retrieved documents.
 */
const ORIGIN_SECTIONS: ReadonlyArray<{
  origin: SourcesPartItem["origin"]
  headerKey: string
}> = [
  { origin: "twin-rag", headerKey: "retrievedChunksHeader" },
  { origin: "twin-style", headerKey: "styleSamplesHeader" },
  { origin: "memory", headerKey: "recalledMemoriesHeader" },
  { origin: "project-claim", headerKey: "projectClaimsHeader" },
  { origin: "project-history", headerKey: "projectHistoryHeader" },
  { origin: "agent-knowledge-base", headerKey: "agentKnowledgeHeader" },
  { origin: "project-knowledge", headerKey: "projectKnowledgeHeader" },
]

// Origins that are "retrieval feedback" worth auto-expanding when they're the
// only thing shown — i.e. everything that gets its own grouped section.
const AUTO_OPEN_ORIGINS: SourcesPartItem["origin"][] = ORIGIN_SECTIONS.map(
  (section) => section.origin
)

function isOnlyRetrieval(sources: SourcesPartItem[]): boolean {
  return sources.length > 0 && sources.every((s) => AUTO_OPEN_ORIGINS.includes(s.origin))
}

interface OriginSection {
  origin: SourcesPartItem["origin"]
  headerKey: string
  items: SourcesPartItem[]
}

function partition(sources: SourcesPartItem[]): {
  sections: OriginSection[]
  other: SourcesPartItem[]
} {
  const byOrigin = new Map<SourcesPartItem["origin"], SourcesPartItem[]>()
  const other: SourcesPartItem[] = []
  const grouped = new Set(AUTO_OPEN_ORIGINS)
  for (const source of sources) {
    if (!grouped.has(source.origin)) {
      other.push(source)
      continue
    }
    const bucket = byOrigin.get(source.origin)
    if (bucket) bucket.push(source)
    else byOrigin.set(source.origin, [source])
  }
  const sections = ORIGIN_SECTIONS.flatMap((spec) => {
    const items = byOrigin.get(spec.origin)
    return items && items.length > 0 ? [{ ...spec, items }] : []
  })
  return { sections, other }
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
  const { sections, other } = buckets

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
          {sections.map((section) => (
            <section
              key={section.origin}
              className="flex flex-col gap-2"
              data-testid={`sources-part-section-${section.origin}`}
            >
              <h4 className="text-[11px] font-medium text-muted-foreground">
                {t(section.headerKey, { count: section.items.length })}
              </h4>
              <div className="flex flex-col gap-1">
                {section.items.map((source) => (
                  <SourceRow key={source.id} source={source} />
                ))}
              </div>
            </section>
          ))}
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

/**
 * Jump into the conversation a project source came from.
 *
 * A `<button>`, not a `<Link>`. `buildSessionHref` produces a query-param URL,
 * and under the static export a `Link` to it is a full page navigation — which
 * would throw away the point of an in-app jump.
 *
 * The `false` return is handled rather than swallowed: `jumpToSessionMessage`
 * answers false for a deleted session, a compacted-away message, or a user who
 * navigated during the wait. Ignoring it leaves a button that silently does
 * nothing, which reads as broken rather than as "that turn is gone".
 */
const JumpToSourceButton = memo(function JumpToSourceButton({
  messageRef,
}: {
  messageRef: NonNullable<SourcesPartItem["messageRef"]>
}) {
  const t = useTranslations("chat.sourcesPart")
  return (
    <button
      type="button"
      className="ml-auto text-[10px] text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm"
      data-testid="sources-part-jump"
      onClick={() => {
        void import("@/lib/chat/cross-session-jump")
          .then(({ jumpToSessionMessage }) =>
            jumpToSessionMessage(messageRef.sessionId, messageRef.messageId, { align: "center" })
          )
          .then((landed) => {
            if (!landed) toast.error(t("jumpMissing"))
          })
          .catch(() => toast.error(t("jumpMissing")))
      }}
    >
      {t("viewInChat")}
    </button>
  )
})

/**
 * Vote on a memory the assistant just recalled.
 *
 * The three verdicts are deliberately not two. "Wrong" and "outdated" are
 * different statements — one says the memory does not apply here, the other
 * says it stopped being true — and only the second is a fact about the memory
 * itself. Collapsing them would either mark good memories stale or leave no way
 * to say a memory has expired.
 *
 * None of them removes the memory from recall. That is what makes a mis-click
 * survivable on a control with no undo: a vote moves ranking, and the two
 * destructive intents (correct it, archive it) keep their own confirmed entry
 * points in `/memory`.
 *
 * Local `voted` state, not a store read: the row is a snapshot of one turn, and
 * subscribing every chip to the memory table would turn a strip of citations
 * into a live query per source.
 */
const RETRIEVAL_FEEDBACK_OPTIONS = [
  { verdict: "helpful", labelKey: "feedbackHelpful", Icon: ThumbsUpIcon },
  { verdict: "wrong", labelKey: "feedbackWrong", Icon: ThumbsDownIcon },
  { verdict: "outdated", labelKey: "feedbackOutdated", Icon: ClockAlertIcon },
] as const

const MemoryFeedbackButtons = memo(function MemoryFeedbackButtons({
  memoryId,
}: {
  memoryId: string
}) {
  const t = useTranslations("chat.sourcesPart")
  const [voted, setVoted] = useState<string | null>(null)

  const vote = useCallback(
    (verdict: (typeof RETRIEVAL_FEEDBACK_OPTIONS)[number]["verdict"]) => {
      setVoted(verdict)
      void import("@/lib/memory/control-plane/manage")
        .then(({ manageMemory }) =>
          manageMemory({ kind: "retrieval-feedback", id: memoryId, verdict })
        )
        .then((result) => {
          if (result.ok) toast.success(t("feedbackRecorded"))
          else {
            setVoted(null)
            toast.error(t("feedbackFailed"))
          }
        })
        .catch(() => {
          setVoted(null)
          toast.error(t("feedbackFailed"))
        })
    },
    [memoryId, t]
  )

  return (
    <span
      className="ml-auto flex shrink-0 items-center gap-0.5"
      data-testid="sources-part-feedback"
    >
      {RETRIEVAL_FEEDBACK_OPTIONS.map(({ verdict, labelKey, Icon }) => (
        <button
          key={verdict}
          type="button"
          disabled={voted !== null}
          aria-pressed={voted === verdict}
          title={t(labelKey)}
          aria-label={t(labelKey)}
          data-testid={`sources-part-feedback-${verdict}`}
          className={cn(
            "rounded-sm p-0.5 text-muted-foreground transition-colors",
            "hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            "disabled:pointer-events-none disabled:opacity-40",
            voted === verdict && "text-primary opacity-100"
          )}
          onClick={(event) => {
            // The row can be wrapped in a link (a web source) and always sits
            // inside a collapsible trigger's subtree; without this a vote also
            // navigates or folds the strip away.
            event.preventDefault()
            event.stopPropagation()
            vote(verdict)
          }}
        >
          <Icon className="size-3" aria-hidden="true" />
        </button>
      ))}
    </span>
  )
})

function originIcon(origin: SourcesPartItem["origin"]) {
  if (origin === "project-claim" || origin === "project-history") {
    return (
      <FolderGit2Icon
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    )
  }
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
          {source.messageRef && !source.chunkRef && (
            <JumpToSourceButton messageRef={source.messageRef} />
          )}
          {source.memoryRef && <MemoryFeedbackButtons memoryId={source.memoryRef} />}
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
        preferEmbedded
      >
        {body}
      </ExternalLink>
    )
  }
  return <div className="rounded px-1 py-0.5">{body}</div>
})

export default SourcesPart
