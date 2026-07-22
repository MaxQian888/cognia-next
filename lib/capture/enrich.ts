/**
 * Capture enrichment — URL → clean markdown (Phase-1 web reader), image → OCR
 * text (`lib/ocr`). Deps are injected so it unit-tests without network/OCR.
 */

import type { CaptureCandidate, CaptureEnrichment } from "@/types/capture"

export interface EnrichDeps {
  readUrl?: (url: string) => Promise<{ markdown: string; title?: string } | null>
  ocrImage?: (dataUrl: string) => Promise<{ text: string } | null>
}

export interface BuildEnrichDepsOptions {
  /** Allow the third-party Jina Reader fallback for thin pages. Defaults to Tauri only. */
  jinaFallback?: boolean
}

export async function enrichCandidate(
  candidate: CaptureCandidate,
  deps: EnrichDeps
): Promise<CaptureEnrichment | undefined> {
  if (candidate.kind === "url" && candidate.sourceUrl && deps.readUrl) {
    const r = await deps.readUrl(candidate.sourceUrl).catch(() => null)
    if (r?.markdown?.trim()) {
      return { markdown: r.markdown, ...(r.title ? { title: r.title } : {}), via: "url-reader" }
    }
  }
  if (candidate.kind === "image" && candidate.imageDataUrl && deps.ocrImage) {
    const r = await deps.ocrImage(candidate.imageDataUrl).catch(() => null)
    if (r?.text?.trim()) return { markdown: r.text, via: "ocr" }
  }
  return undefined
}

/**
 * Production enrich deps: the Phase-1 web reader (CORS-free on Tauri) for URLs
 * and the OCR pipeline for images. Lazy-imported so the pure module above stays
 * dependency-light.
 */
export function buildEnrichDeps(options: BuildEnrichDepsOptions = {}): EnrichDeps {
  return {
    readUrl: async (url) => {
      const { fetchUrlAsRawSource } = await import("@/lib/twin/ingest/url-fetcher")
      const { createProxyFetch } = await import("@/lib/network/proxy-fetch")
      const { isTauri } = await import("@/lib/native/utils")
      const tauri = isTauri()
      const fetchImpl = tauri ? (createProxyFetch() as typeof fetch) : undefined
      const r = await fetchUrlAsRawSource(url, {
        ...(fetchImpl ? { fetchImpl } : {}),
        jinaFallback: options.jinaFallback ?? tauri,
      })
      return { markdown: r.text, ...(r.title ? { title: r.title } : {}) }
    },
    ocrImage: async (dataUrl) => {
      const { extract } = await import("@/lib/ocr")
      const { buildOcrDeps } = await import("@/lib/ocr/deps")
      const mimeType = dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png"
      const res = (await extract(
        { source: { kind: "data-url", dataUrl, mimeType } },
        buildOcrDeps()
      )) as { text?: string; markdown?: string }
      const text = res.markdown?.trim() || res.text?.trim() || ""
      return text ? { text } : null
    },
  }
}
