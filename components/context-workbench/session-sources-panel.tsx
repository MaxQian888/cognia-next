"use client"

import { useMemo, useState, type ReactNode } from "react"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import { FileTextIcon, Globe2Icon, SearchIcon, WrenchIcon } from "lucide-react"
import { ExternalLink } from "@/components/shared/external-link"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  collectSessionSources,
  type SessionSource,
  type SessionSourceKind,
} from "@/lib/chat/session-sources"
import { cn } from "@/lib/utils"

function SourceIcon({ kind }: { kind: SessionSourceKind }) {
  if (kind === "web") return <Globe2Icon className="size-4" aria-hidden />
  if (kind === "file") return <FileTextIcon className="size-4" aria-hidden />
  return <WrenchIcon className="size-4" aria-hidden />
}

function SourceRow({
  source,
  children,
}: {
  source: SessionSource
  children: (content: ReactNode) => ReactNode
}) {
  const t = useTranslations("contextWorkbench.sessionSources")
  const content = (
    <>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <SourceIcon kind={source.kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{source.title}</span>
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
            {t(`labels.${source.label}`)}
          </Badge>
        </span>
        {source.detail ? (
          <span className="mt-0.5 line-clamp-2 block break-all text-xs text-muted-foreground">
            {source.detail}
          </span>
        ) : null}
        <span className="mt-1 block text-[10px] text-muted-foreground/80">
          {t("messageLabel", { n: source.messageNumber })}
        </span>
      </span>
    </>
  )
  return children(content)
}

export function SessionSourcesPanel({ messages }: { messages: readonly UIMessage[] }) {
  const t = useTranslations("contextWorkbench.sessionSources")
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<"all" | SessionSourceKind>("all")
  const sources = useMemo(
    () =>
      collectSessionSources(messages, {
        document: t("labels.document"),
        file: t("labels.file"),
      }),
    [messages, t]
  )
  const counts = useMemo(
    () => ({
      all: sources.length,
      web: sources.filter((source) => source.kind === "web").length,
      file: sources.filter((source) => source.kind === "file").length,
      other: sources.filter((source) => source.kind === "other").length,
    }),
    [sources]
  )
  const visibleSources = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return sources.filter((source) => {
      if (kind !== "all" && source.kind !== kind) return false
      if (!normalizedQuery) return true
      return [source.title, source.detail, source.url]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
    })
  }, [kind, query, sources])

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t("title")}>
      <header className="shrink-0 border-b p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
          </div>
          <Badge variant="secondary">{counts.all}</Badge>
        </div>
        <div className="relative mt-3">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchLabel")}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Tabs
          value={kind}
          onValueChange={(value) => setKind(value as "all" | SessionSourceKind)}
          className="mt-2"
        >
          <TabsList className="grid h-8 w-full grid-cols-4">
            {(
              [
                ["all", "all", counts.all],
                ["web", "web", counts.web],
                ["file", "files", counts.file],
                ["other", "other", counts.other],
              ] as const
            ).map(([value, label, count]) => (
              <TabsTrigger
                key={value}
                value={value}
                onClick={() => setKind(value)}
                className="h-7 gap-1 px-1 text-xs"
              >
                <span>{t(`filters.${label}`)}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      {sources.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <FileTextIcon className="mb-3 size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("emptyDescription")}</p>
        </div>
      ) : visibleSources.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <SearchIcon className="mb-3 size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-sm font-medium">{t("noResultsTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("noResultsDescription")}</p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 p-2">
            {visibleSources.map((source) => (
              <SourceRow key={source.id} source={source}>
                {(content) =>
                  source.url ? (
                    <ExternalLink
                      href={source.url}
                      className={cn(
                        "flex items-start gap-2 rounded-lg border border-transparent p-2",
                        "transition-colors hover:border-border hover:bg-muted/60",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                      )}
                      data-testid="session-source-row"
                      data-kind={source.kind}
                    >
                      {content}
                    </ExternalLink>
                  ) : (
                    <div
                      className="flex items-start gap-2 rounded-lg p-2"
                      data-testid="session-source-row"
                      data-kind={source.kind}
                    >
                      {content}
                    </div>
                  )
                }
              </SourceRow>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  )
}
