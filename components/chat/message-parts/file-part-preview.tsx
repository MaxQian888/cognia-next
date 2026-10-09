"use client"

// Inline preview for non-image `file` message parts. Markdown files use the
// shared rendered/source surfaces, HTML files render live in the same
// sanitized sandbox iframe the static artifact preview uses, other text files
// keep the existing copyable CodeBlock, PDFs embed via <object>, and videos
// play in the shared VideoBlock player. Binary or unknown files and fetch
// failures retain the plain download fallback.

import { memo, useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, DownloadIcon, Loader2Icon } from "lucide-react"
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments"
import { FileTypeBadge } from "@/components/shared/file-type-icon"
import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { VideoBlock } from "@/components/chat/renderers/video-block"
import { languageFromPath } from "@/components/chat/message-parts/mcp-renderers/common"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DIAGRAM_DESIGN_THEME_DEFAULTS,
  DIAGRAM_DESIGN_THEME_KEYS,
  renderHTML,
} from "@/lib/artifacts"
import { useThemeCssVars } from "@/lib/appearance/use-theme-css-vars"

export interface FilePartPreviewProps {
  url: string
  mediaType?: string
  filename?: string
  /**
   * Leave out the download card a preview falls back to: set by a host that
   * already offers the download beside the preview (`FilePartCard`), so the
   * file is not named twice.
   */
  hideDownloadFallback?: boolean
}

/** A textual media type (covers `text/*` plus the common `application/*` text formats). */
function isTextLike(mediaType: string | undefined, filename: string | undefined): boolean {
  if (mediaType?.startsWith("text/")) return true
  if (
    mediaType &&
    /(json|xml|javascript|typescript|ecmascript|x-yaml|yaml|x-sh|x-shellscript|csv|markdown|toml|x-www-form-urlencoded)/i.test(
      mediaType
    )
  ) {
    return true
  }
  // Fall back to the filename extension — languageFromPath returns "text" for
  // anything it doesn't recognize as code.
  return /\.(?:md|markdown|mdx)$/i.test(filename ?? "") || languageFromPath(filename) !== "text"
}

function isPdf(mediaType: string | undefined, filename: string | undefined): boolean {
  return mediaType === "application/pdf" || /\.pdf$/i.test(filename ?? "")
}

/** A container the webview's `<video>` can play. */
function isVideo(mediaType: string | undefined, filename: string | undefined): boolean {
  if (mediaType) return /^video\/(?:mp4|webm|ogg|quicktime)\b/i.test(mediaType)
  return /\.(?:mp4|m4v|webm|ogv|mov)$/i.test(filename ?? "")
}

function isMarkdown(mediaType: string | undefined, filename: string | undefined): boolean {
  return (
    /(?:^|[/+.-])(?:markdown|mdx)(?:$|[;+.-])/i.test(mediaType ?? "") ||
    /\.(?:md|markdown|mdx)$/i.test(filename ?? "")
  )
}

function isHtml(mediaType: string | undefined, filename: string | undefined): boolean {
  return mediaType === "text/html" || /\.html?$/i.test(filename ?? "")
}

/**
 * Live render for an HTML file, through the exact machinery the static
 * artifact preview uses: DOMPurify-sanitized markup written into a
 * `sandbox="allow-same-origin"` iframe (same-origin because the parent writes
 * `contentDocument`), with the app's theme variables injected so an unstyled
 * document still matches dark/light. Scripts and forms never reach the frame.
 */
function HtmlPreviewFrame({ html, title }: { html: string; title: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const themeVariables = useThemeCssVars(DIAGRAM_DESIGN_THEME_KEYS, DIAGRAM_DESIGN_THEME_DEFAULTS)
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument
    if (doc) renderHTML(doc, html, { themeVariables })
  }, [html, themeVariables])
  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin"
      title={title}
      className="h-64 w-full rounded-md border bg-background sm:h-80 md:h-96"
      data-testid="file-preview-html-frame"
    />
  )
}

/** A file part as the AI Elements attachment primitives describe it. */
function useAttachmentData(
  url: string,
  mediaType: string | undefined,
  displayName: string
): AttachmentData {
  return useMemo(
    () => ({ id: url, type: "file", url, mediaType: mediaType ?? "", filename: displayName }),
    [url, mediaType, displayName]
  )
}

/**
 * The file card every sent file shares (the composer drew the same one before
 * the send): the AI Elements `list` attachment with the shared file-type badge
 * and the name. `children` is what sits at its right.
 */
function FileCardRow({
  url,
  mediaType,
  displayName,
  meta,
  children,
}: {
  url: string
  mediaType: string | undefined
  displayName: string
  meta?: string
  children?: React.ReactNode
}) {
  const data = useAttachmentData(url, mediaType, displayName)
  return (
    <Attachments variant="list" className="w-full">
      <Attachment data={data} className="gap-2.5 rounded-xl border-0 p-2 hover:bg-transparent">
        <AttachmentPreview
          className="size-auto rounded-none bg-transparent"
          fallbackIcon={<FileTypeBadge path={displayName} className="size-10" />}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <AttachmentInfo className="text-xs font-medium" title={displayName} />
          {meta ? (
            <span className="truncate text-[10.5px] leading-none text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </span>
        {children}
      </Attachment>
    </Attachments>
  )
}

/** Plain downloadable file card — the universal fallback (unknown/binary types). */
function DownloadLink({ url, displayName }: { url: string; displayName: string }) {
  const t = useTranslations("chat.filePreview")
  return (
    <a
      href={url}
      download={displayName}
      className="my-1 block w-full max-w-md rounded-xl border bg-card shadow-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="file-download-link"
      title={displayName}
      aria-label={t("download", { name: displayName })}
    >
      <FileCardRow url={url} mediaType={undefined} displayName={displayName}>
        <DownloadIcon className="me-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </FileCardRow>
    </a>
  )
}

/** Fetch the text body of a (data:/blob:/http) URL. Null while loading; false on error. */
function useFileText(url: string, enabled: boolean): string | null | false {
  // Key the result by the URL it belongs to so a URL change reads as loading
  // (null) during render — no synchronous state reset inside the effect.
  const [result, setResult] = useState<{ url: string; value: string | false } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (!cancelled) setResult({ url, value: body })
      })
      .catch(() => {
        if (!cancelled) setResult({ url, value: false })
      })
    return () => {
      cancelled = true
    }
  }, [url, enabled])
  return result && result.url === url ? result.value : null
}

export const FilePartPreview = memo(function FilePartPreview({
  url,
  mediaType,
  filename,
  hideDownloadFallback = false,
}: FilePartPreviewProps) {
  const t = useTranslations("chat.filePreview")
  const displayName = filename ?? url
  const pdf = isPdf(mediaType, filename)
  const video = !pdf && isVideo(mediaType, filename)
  const textLike = !pdf && !video && isTextLike(mediaType, filename)
  const markdown = textLike && isMarkdown(mediaType, filename)
  const html = textLike && isHtml(mediaType, filename)
  const text = useFileText(url, textLike)

  if (pdf) {
    return (
      <div className="my-1 overflow-hidden rounded border" data-testid="file-preview-pdf">
        <object
          data={url}
          type="application/pdf"
          className="h-64 w-full sm:h-80 md:h-96"
          aria-label={displayName}
        >
          <div className="p-2 text-sm">
            <p className="mb-1 text-muted-foreground">{t("pdfFallback")}</p>
            {hideDownloadFallback ? null : <DownloadLink url={url} displayName={displayName} />}
          </div>
        </object>
      </div>
    )
  }

  if (video) {
    return (
      <div className="my-1" data-testid="file-preview-video">
        <VideoBlock src={url} title={displayName} />
      </div>
    )
  }

  if (textLike) {
    if (text === false) {
      return hideDownloadFallback ? (
        <p className="text-xs text-muted-foreground" data-testid="file-preview-unavailable">
          {t("previewUnavailable")}
        </p>
      ) : (
        <DownloadLink url={url} displayName={displayName} />
      )
    }
    if (text === null) {
      return (
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="file-preview-loading"
        >
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
          <span className="truncate">{t("loading", { name: displayName })}</span>
        </p>
      )
    }
    if (html) {
      // Same Preview/Source split as Markdown: an HTML attachment's point is
      // the page it paints, not its markup — the source stays one tab away.
      return (
        <Tabs
          key={url}
          defaultValue="preview"
          className="my-1 gap-1"
          data-testid="file-preview-html"
        >
          <TabsList variant="line" className="h-7">
            <TabsTrigger value="preview" className="px-2 text-xs">
              {t("preview")}
            </TabsTrigger>
            <TabsTrigger value="source" className="px-2 text-xs">
              {t("source")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="preview">
            <HtmlPreviewFrame html={text} title={displayName} />
          </TabsContent>
          <TabsContent value="source" className="max-h-96 overflow-auto">
            <CodeBlock code={text} language="html" filename={filename} />
          </TabsContent>
        </Tabs>
      )
    }
    if (markdown) {
      return (
        <Tabs
          key={url}
          defaultValue="preview"
          className="my-1 gap-1"
          data-testid="file-preview-text"
        >
          <TabsList variant="line" className="h-7">
            <TabsTrigger value="preview" className="px-2 text-xs">
              {t("preview")}
            </TabsTrigger>
            <TabsTrigger value="source" className="px-2 text-xs">
              {t("source")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="preview" className="max-h-96 overflow-auto rounded border p-3">
            <MarkdownRenderer content={text} rhythm="document" />
          </TabsContent>
          <TabsContent value="source" className="max-h-96 overflow-auto">
            <CodeBlock code={text} language="markdown" filename={filename} />
          </TabsContent>
        </Tabs>
      )
    }
    return (
      <div className="my-1" data-testid="file-preview-text">
        <CodeBlock code={text} language={languageFromPath(filename)} filename={filename} />
      </div>
    )
  }

  return <DownloadLink url={url} displayName={displayName} />
})

/** What `FilePartPreview` will draw for a file part. */
export type FilePreviewKind = "pdf" | "video" | "html" | "markdown" | "text" | "file"

export function filePreviewKind(
  mediaType: string | undefined,
  filename: string | undefined
): FilePreviewKind {
  if (isPdf(mediaType, filename)) return "pdf"
  if (isVideo(mediaType, filename)) return "video"
  if (!isTextLike(mediaType, filename)) return "file"
  if (isHtml(mediaType, filename)) return "html"
  if (isMarkdown(mediaType, filename)) return "markdown"
  return "text"
}

/**
 * A file part in the transcript: the shared file card, with its inline
 * preview (PDF, video, page, document or code) under the header, which
 * collapses it, and a download action beside it. A file with no inline
 * preview is the download card alone.
 */
export const FilePartCard = memo(function FilePartCard({
  url,
  mediaType,
  filename,
  defaultExpanded = true,
}: FilePartPreviewProps & {
  /** Whether the preview starts open. */
  defaultExpanded?: boolean
}) {
  const t = useTranslations("chat.filePreview")
  const [open, setOpen] = useState(defaultExpanded)
  const bodyId = useId()
  const displayName = filename ?? url
  const kind = filePreviewKind(mediaType, filename)
  if (kind === "file") return <DownloadLink url={url} displayName={displayName} />
  return (
    <div
      className={cn(
        "my-1 w-full overflow-hidden rounded-xl border bg-card shadow-xs",
        // A closed card is as wide as every other file card; an open preview
        // gets room for a page or a code listing.
        open ? "max-w-2xl" : "max-w-md"
      )}
      data-testid="file-part-card"
    >
      <div className="flex items-center pe-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={t("toggle", { name: displayName })}
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 rounded-xl text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <FileCardRow
            url={url}
            mediaType={mediaType}
            displayName={displayName}
            meta={t(`kind.${kind}`)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90"
              )}
            />
          </FileCardRow>
        </button>
        <a
          href={url}
          download={displayName}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("download", { name: displayName })}
          title={t("download", { name: displayName })}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          data-testid="file-part-card-download"
        >
          <DownloadIcon className="size-4" aria-hidden />
        </a>
      </div>
      {open ? (
        <div id={bodyId} className="border-t p-2 [&>*]:my-0" data-testid="file-part-card-body">
          <FilePartPreview
            url={url}
            mediaType={mediaType}
            filename={filename}
            hideDownloadFallback
          />
        </div>
      ) : null}
    </div>
  )
})
