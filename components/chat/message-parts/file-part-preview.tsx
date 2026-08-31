"use client"

// Inline preview for non-image `file` message parts. Markdown files use the
// shared rendered/source surfaces, other text files keep the existing
// copyable CodeBlock, and PDFs embed via <object>. Binary or unknown files and
// fetch failures retain the plain download fallback.

import { memo, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { languageFromPath } from "@/components/chat/message-parts/mcp-renderers/common"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export interface FilePartPreviewProps {
  url: string
  mediaType?: string
  filename?: string
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

function isMarkdown(mediaType: string | undefined, filename: string | undefined): boolean {
  return (
    /(?:^|[/+.-])(?:markdown|mdx)(?:$|[;+.-])/i.test(mediaType ?? "") ||
    /\.(?:md|markdown|mdx)$/i.test(filename ?? "")
  )
}

/** Plain downloadable link — the universal fallback (unknown/binary types). */
function DownloadLink({ url, displayName }: { url: string; displayName: string }) {
  return (
    <a
      href={url}
      download={displayName}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="file-download-link"
      title={displayName}
    >
      <FileTypeIcon path={displayName} />
      <span className="truncate">{displayName}</span>
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
}: FilePartPreviewProps) {
  const t = useTranslations("chat.filePreview")
  const displayName = filename ?? url
  const pdf = isPdf(mediaType, filename)
  const textLike = !pdf && isTextLike(mediaType, filename)
  const markdown = textLike && isMarkdown(mediaType, filename)
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
            <DownloadLink url={url} displayName={displayName} />
          </div>
        </object>
      </div>
    )
  }

  if (textLike) {
    if (text === false) return <DownloadLink url={url} displayName={displayName} />
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
