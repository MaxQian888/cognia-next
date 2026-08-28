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
import { isSourcesPart, type SourcesPartItem } from "@/lib/claude/parts-extensions"
import { cn } from "@/lib/utils"

type SessionSourceKind = "web" | "file" | "other"
type SessionSourceLabel =
  | "web"
  | "file"
  | "document"
  | "tool"
  | "anthropic"
  | "cogniaWeb"
  | "twinRag"
  | "twinStyle"
  | "agentKnowledge"
  | "memory"
  | "projectKnowledge"
  | "footnote"

interface SessionSource {
  id: string
  kind: SessionSourceKind
  label: SessionSourceLabel
  title: string
  detail?: string
  url?: string
  messageNumber: number
}

const HTTP_URL_RE = /^https?:\/\//i

function sourceLabel(origin: SourcesPartItem["origin"]): SessionSourceLabel {
  if (origin === "cognia-web") return "cogniaWeb"
  if (origin === "twin-rag") return "twinRag"
  if (origin === "twin-style") return "twinStyle"
  if (origin === "agent-knowledge-base") return "agentKnowledge"
  // The workspace-knowledge origin had no label at all, so the panel asked for
  // `labels.project-knowledge` and rendered the raw key.
  if (origin === "project-knowledge") return "projectKnowledge"
  return origin
}

function sourceKind(source: SourcesPartItem): SessionSourceKind {
  if (
    source.url &&
    HTTP_URL_RE.test(source.url) &&
    (source.origin === "anthropic" ||
      source.origin === "cognia-web" ||
      source.origin === "footnote")
  ) {
    return "web"
  }
  return "other"
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function filenameFromUrl(url: string): string | undefined {
  if (!HTTP_URL_RE.test(url)) return undefined
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).at(-1)
    return name ? decodeURIComponent(name) : undefined
  } catch {
    return undefined
  }
}

function compactValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value.trim() || undefined
  try {
    const serialized = JSON.stringify(value)
    return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized
  } catch {
    return String(value)
  }
}

function toolNameOfPart(part: Record<string, unknown>, type: string): string {
  if (type === "dynamic-tool" && typeof part.toolName === "string") return part.toolName
  return type.startsWith("tool-") ? type.slice("tool-".length) : type
}

function collectSessionSources(
  messages: readonly UIMessage[],
  fallbackLabels: { document: string; file: string }
): SessionSource[] {
  const collected = new Map<string, SessionSource>()

  const add = (source: SessionSource) => {
    const existing = collected.get(source.id)
    if (!existing) {
      collected.set(source.id, source)
      return
    }
    collected.set(source.id, {
      ...existing,
      detail: existing.detail ?? source.detail,
      url: existing.url ?? source.url,
    })
  }

  messages.forEach((message, messageIndex) => {
    message.parts.forEach((rawPart, partIndex) => {
      const part = rawPart as unknown as Record<string, unknown>
      const type = typeof part.type === "string" ? part.type : ""
      const messageNumber = messageIndex + 1

      if (type === "source-url" && typeof part.url === "string") {
        const url = part.url
        add({
          id: `web:${url}`,
          kind: "web",
          label: "web",
          title:
            typeof part.title === "string" && part.title.trim()
              ? part.title
              : (safeHostname(url) ?? url),
          detail: safeHostname(url),
          url,
          messageNumber,
        })
        return
      }

      if (type === "source-document") {
        const title =
          (typeof part.filename === "string" && part.filename) ||
          (typeof part.title === "string" && part.title) ||
          (typeof part.sourceId === "string" && part.sourceId) ||
          fallbackLabels.document
        const detail = [part.title, part.mediaType]
          .filter((value): value is string => typeof value === "string" && value !== title)
          .join(" · ")
        add({
          id: `document:${String(part.sourceId ?? title)}`,
          kind: "file",
          label: "document",
          title,
          detail: detail || undefined,
          messageNumber,
        })
        return
      }

      if (type === "file") {
        const url = typeof part.url === "string" ? part.url : undefined
        const mediaType = typeof part.mediaType === "string" ? part.mediaType : undefined
        const title =
          (typeof part.filename === "string" && part.filename) ||
          (url && filenameFromUrl(url)) ||
          mediaType ||
          fallbackLabels.file
        const externalUrl = url && HTTP_URL_RE.test(url) ? url : undefined
        add({
          id: externalUrl
            ? `file:${externalUrl}`
            : `file:${title}:${mediaType ?? ""}:${message.id}:${partIndex}`,
          kind: "file",
          label: "file",
          title,
          detail: mediaType,
          url: externalUrl,
          messageNumber,
        })
        return
      }

      if (isSourcesPart(part)) {
        part.sources.forEach((source) => {
          const kind = sourceKind(source)
          const url = source.url && HTTP_URL_RE.test(source.url) ? source.url : undefined
          const detail = [url ? safeHostname(url) : undefined, source.snippet]
            .filter(Boolean)
            .join(" · ")
          add({
            id: kind === "web" && url ? `web:${url}` : `other:${source.origin}:${source.id}`,
            kind,
            label: sourceLabel(source.origin),
            title: source.title,
            detail: detail || undefined,
            url,
            messageNumber,
          })
        })
        return
      }

      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        const toolName = toolNameOfPart(part, type)
        add({
          id: `tool:${String(part.toolCallId ?? `${message.id}:${partIndex}`)}`,
          kind: "other",
          label: "tool",
          title: toolName,
          detail: compactValue(part.input),
          messageNumber,
        })
      }
    })
  })

  return [...collected.values()]
}

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
