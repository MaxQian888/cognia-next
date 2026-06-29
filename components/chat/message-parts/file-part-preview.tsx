"use client"

// gap2 — inline preview for non-image `file` message parts. Text/code files
// render through the shared CodeBlock (syntax-highlighted, copyable); PDFs
// embed via <object>; everything else (binary / unknown) keeps the plain
// download link. The download link is always available as a fallback, so a
// fetch failure or an unsupported type degrades gracefully.

import { memo, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { languageFromPath } from "@/components/chat/message-parts/mcp-renderers/common"

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
  return languageFromPath(filename) !== "text"
}

function isPdf(mediaType: string | undefined, filename: string | undefined): boolean {
  return mediaType === "application/pdf" || /\.pdf$/i.test(filename ?? "")
}

/** Plain downloadable link — the universal fallback (unknown/binary types). */
function DownloadLink({ url, displayName }: { url: string; displayName: string }) {
  return (
    <a
      href={url}
      download={displayName}
      className="inline-flex items-center gap-1.5 rounded border px-2 py-1 text-sm hover:bg-muted"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="file-download-link"
    >
      <span aria-hidden>📎</span>
      {displayName}
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
  const text = useFileText(url, textLike)

  if (pdf) {
    return (
      <div className="my-1 overflow-hidden rounded border" data-testid="file-preview-pdf">
        <object data={url} type="application/pdf" className="h-72 w-full" aria-label={displayName}>
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
        <p className="text-xs text-muted-foreground" data-testid="file-preview-loading">
          {t("loading", { name: displayName })}
        </p>
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
