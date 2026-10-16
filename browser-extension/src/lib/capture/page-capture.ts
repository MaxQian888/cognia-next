import type { BrowserPageMetadataV1 } from "@cognia/companion-client"
import { extractArticle } from "./extract-article"
import { extractMetadata } from "./extract-metadata"
import { extractFromDocument } from "./extract-visible-text"
import { selectionToMarkdown, selectionToText } from "./selection-markdown"

export interface PageCapture {
  title: string
  url: string
  selection: { text: string; markdown: string } | null
  readableText: string | null
  readableCharacterCount: number
  article: { markdown: string; characterCount: number } | null
  metadata: BrowserPageMetadataV1
  /** document.contentType === "application/pdf" or the Chrome PDF viewer embed. */
  isPdf: boolean
}

export interface PageCaptureOptions {
  wholePage: boolean
  article: boolean
}

declare global {
  var __cogniaPageCapture: { capture(options: PageCaptureOptions): PageCapture } | undefined
}

export function capturePage(doc: Document, options: PageCaptureOptions): PageCapture {
  // The legacy extractor is injected by value and deliberately reads its own
  // realm's document. Never silently mix another document with that content.
  if (doc !== document) throw new Error("capture must run in the page's document")
  const extracted = extractFromDocument(options.wholePage)
  const selection = doc.defaultView?.getSelection()
  const markdown = selection ? selectionToMarkdown(selection, doc.baseURI) : ""
  const text = selection ? selectionToText(selection) : ""
  const article = options.article ? extractArticle(doc) : null
  return {
    title: article?.title || extracted.title,
    url: extracted.url,
    selection: text && markdown ? { text, markdown } : null,
    readableText: extracted.readableText,
    readableCharacterCount: extracted.readableCharacterCount,
    article: article
      ? { markdown: article.markdown, characterCount: article.characterCount }
      : null,
    metadata: extractMetadata(doc),
    isPdf:
      doc.contentType === "application/pdf" ||
      Boolean(doc.querySelector('embed[type="application/pdf"], object[type="application/pdf"]')),
  }
}
