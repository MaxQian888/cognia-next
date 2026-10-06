"use client"

/**
 * The preview card shown over an external link (ADR-0218), in messages and in
 * the composer.
 *
 * Presentational: it renders whatever `useLinkPreview` reports. `local` (the
 * browser build, or a turn still streaming) and `error` draw from the URL
 * alone — site mark, host, the `describeLink` label and the path — so the card
 * is never empty and never waits on a request that will not happen.
 */

import { CheckIcon, CopyIcon, ExternalLinkIcon, FileIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { ExternalLink } from "@/components/shared/external-link"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { usePreviewImage, type LinkPreviewState } from "@/hooks/chat/use-link-preview"
import { useCopy } from "@/hooks/ui/use-copy"
import { describeLink } from "@/lib/chat/link-display"
import { canFetchLinkPreviews } from "@/lib/web/link-preview/fetch-preview"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import { LinkSiteIcon } from "./link-site-icon"

export interface LinkPreviewCardProps {
  url: string
  state: LinkPreviewState
  /** Whether the favicon / preview image may be requested. */
  allowFetch: boolean
  className?: string
}

/** Host + path + query, without the scheme or a trailing slash. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const rest = `${parsed.host.replace(/^www\./i, "")}${parsed.pathname}${parsed.search}`
    return rest.endsWith("/") ? rest.slice(0, -1) : rest
  } catch {
    return url
  }
}

/** `application/pdf` → `PDF`, `text/csv` → `CSV`. */
export function fileTypeLabel(contentType: string | undefined): string | null {
  if (!contentType) return null
  const subtype = contentType.split("/")[1] ?? ""
  const short = subtype.split(/[.+-]/).filter(Boolean).pop() ?? subtype
  return short ? short.toUpperCase() : null
}

function PreviewImage({ src, alt, allowFetch }: { src: string; alt: string; allowFetch: boolean }) {
  const image = usePreviewImage(src, allowFetch)
  if (!image.src) return null
  return (
    <div className="aspect-[1.91/1] w-full overflow-hidden border-b bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element -- remote or data: preview image of unknown size */}
      <img
        src={image.src}
        alt={alt}
        className="size-full object-cover"
        onError={image.onError}
        referrerPolicy="no-referrer"
        loading="lazy"
        data-testid="link-preview-image"
      />
    </div>
  )
}

export function LinkPreviewCard({ url, state, allowFetch, className }: LinkPreviewCardProps) {
  const t = useTranslations("chat.linkPreview")
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })
  const local = describeLink(url)
  const preview = state.status === "ready" ? state.preview : null
  const title = preview?.title ?? local.label
  const site = preview?.siteName ?? preview?.host ?? local.host
  const fileType = preview?.kind === "file" ? fileTypeLabel(preview.contentType) : null

  let note: string | null = null
  if (state.status === "error") note = t("unavailable")
  else if (state.status === "local" && allowFetch && !canFetchLinkPreviews())
    note = t("browserOnly")

  return (
    <div
      className={cn("w-80 overflow-hidden text-left", className)}
      data-testid="link-preview-card"
      data-state={state.status}
      aria-label={t("label", { host: local.host })}
    >
      {preview?.imageUrl ? (
        <PreviewImage
          src={preview.imageUrl}
          alt={preview.imageAlt ?? preview.title ?? ""}
          allowFetch={allowFetch}
        />
      ) : null}
      <div className="space-y-1.5 p-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <LinkSiteIcon url={url} allowFetch={allowFetch} className="me-0 shrink-0" />
          <span className="truncate">{site}</span>
          {fileType ? (
            <span className="ms-auto inline-flex shrink-0 items-center gap-1 rounded border px-1 py-px text-[10px] font-medium uppercase">
              <FileIcon className="size-3" aria-hidden />
              {fileType}
            </span>
          ) : null}
        </div>
        {state.status === "loading" ? (
          <div className="space-y-1.5" aria-label={t("loading")} role="status">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ) : (
          <>
            <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
              {title}
            </p>
            {preview?.description ? (
              <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {preview.description}
              </p>
            ) : null}
          </>
        )}
        <p className="truncate font-mono text-[11px] text-muted-foreground/80" title={url}>
          {displayUrl(preview?.finalUrl ?? url)}
        </p>
        {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      </div>
      <div className="flex items-center gap-1 border-t bg-muted/30 px-1.5 py-1">
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
          <ExternalLink href={url} preferEmbedded>
            <ExternalLinkIcon className="size-3.5" aria-hidden />
            {t("open")}
          </ExternalLink>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => void copy(url)}
        >
          {copied ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden />
          )}
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
    </div>
  )
}
