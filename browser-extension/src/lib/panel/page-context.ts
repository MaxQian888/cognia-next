/**
 * From a page capture to what is sent (ADR-0228 §1–§2).
 *
 * Two steps, both pure. `toCapturedPage` turns what the in-page capture and
 * the transcript reader answered into the panel's {@link CapturedPage}, cut to
 * the Host's byte ceilings so the preview shows exactly what will be sent.
 * `buildPageContext` turns a reviewed page into the wire context, sending each
 * richer field only when the Host listed it in `capability.features`: an older
 * Host gets the shape it always got, never a field it would silently drop.
 */
import {
  clipToBytes,
  utf8ByteLength,
  type BrowserCaptureMode,
  type BrowserCompanionFeature,
  type BrowserContextLimits,
  type BrowserImageContextV1,
  type BrowserLinkContextV1,
  type BrowserPageContextV1,
  type BrowserTranscriptV1,
} from "@cognia/companion-client"

import type { PageCapture } from "../capture/page-capture"
import { captureModeFor, type CapturedPage, type CaptureScope } from "../panel-state"

type Limits = Required<BrowserContextLimits>

function clipped(text: string | null | undefined, limit: number) {
  return text ? clipToBytes(text, limit) : null
}

export interface CaptureInput {
  tabId: number
  /** The tab's own title, when the page offers none. */
  tabTitle: string
  normalizedUrl: string
  rawUrl: string
  strippedQuery: boolean
  capture: PageCapture
  transcript: BrowserTranscriptV1 | null
  link?: BrowserLinkContextV1 | null
  image?: BrowserImageContextV1 | null
  capturedAt: number
}

export function toCapturedPage(input: CaptureInput, limits: Limits): CapturedPage {
  const { capture } = input
  const selection = clipped(capture.selection?.text, limits.selectionBytes)
  const selectionMarkdown = clipped(capture.selection?.markdown, limits.selectionBytes)
  const readable = clipped(capture.readableText, limits.readableTextBytes)
  const article = clipped(capture.article?.markdown, limits.articleBytes)
  const transcript: BrowserTranscriptV1 | null =
    input.transcript?.status === "available"
      ? (() => {
          const cut = clipToBytes(input.transcript.text, limits.transcriptBytes)
          return {
            ...input.transcript,
            text: cut.text,
            truncated: input.transcript.truncated || cut.truncated,
          }
        })()
      : input.transcript
  const title = capture.title || input.tabTitle
  return {
    tabId: input.tabId,
    title,
    originalTitle: title,
    url: input.normalizedUrl,
    rawUrl: input.rawUrl,
    selection: selection
      ? { ...selection, ...(selectionMarkdown ? { markdown: selectionMarkdown.text } : {}) }
      : null,
    readableText: readable
      ? { ...readable, originalCharacterCount: capture.readableCharacterCount }
      : null,
    capturedAt: input.capturedAt,
    strippedQuery: input.strippedQuery,
    article: article
      ? { ...article, originalCharacterCount: capture.article?.characterCount ?? 0 }
      : null,
    metadata: Object.keys(capture.metadata).length > 0 ? capture.metadata : null,
    transcript,
    link: input.link ?? null,
    image: input.image ?? null,
    isPdf: capture.isPdf,
  }
}

/**
 * The page without what this Host would not read, so the preview shows — and
 * counts — exactly what will be sent.
 */
export function withoutUnsupported(
  page: CapturedPage,
  features: readonly BrowserCompanionFeature[]
): CapturedPage {
  const next: CapturedPage = { ...page }
  if (!features.includes("markdown-selection") && next.selection?.markdown !== undefined) {
    const { markdown: _markdown, ...plain } = next.selection
    next.selection = plain
  }
  if (!features.includes("article")) next.article = null
  if (!features.includes("metadata")) next.metadata = null
  if (!features.includes("transcript")) next.transcript = null
  if (!features.includes("link-image")) {
    next.link = null
    next.image = null
  }
  return next
}

/** The text the preview edits for a mode, or null when the mode carries none. */
export function editableText(page: CapturedPage, mode: BrowserCaptureMode): string | null {
  switch (mode) {
    case "selection":
      return page.selection?.markdown ?? page.selection?.text ?? null
    case "readable-page":
      return page.readableText?.text ?? null
    case "article":
      return page.article?.text ?? null
    default:
      return null
  }
}

/**
 * The page with the person's edit applied to the mode's text.
 *
 * `truncated` is kept: it says the text is shorter than the page, which an
 * edit can only make more true. An edit to a selection replaces both its plain
 * and Markdown forms, because the person edited the one they were shown.
 */
export function withEditedText(
  page: CapturedPage,
  mode: BrowserCaptureMode,
  text: string
): CapturedPage {
  switch (mode) {
    case "selection":
      return page.selection
        ? {
            ...page,
            selection: {
              ...page.selection,
              text,
              ...(page.selection.markdown !== undefined ? { markdown: text } : {}),
            },
          }
        : page
    case "readable-page":
      return page.readableText ? { ...page, readableText: { ...page.readableText, text } } : page
    case "article":
      return page.article ? { ...page, article: { ...page.article, text } } : page
    default:
      return page
  }
}

/**
 * The wire context for one reviewed page.
 *
 * Only what the mode names, plus the optional fields the Host listed. The
 * selection travels as Markdown only to a Host that reads `markdown-selection`;
 * otherwise as the plain text it always was.
 */
export function buildPageContext(
  page: CapturedPage,
  scope: CaptureScope | boolean,
  features: readonly BrowserCompanionFeature[]
): BrowserPageContextV1 {
  const mode = captureModeFor(page, scope, features)
  const markdownSelection = features.includes("markdown-selection") && page.selection?.markdown
  const context: BrowserPageContextV1 = {
    schemaVersion: 1,
    captureMode: mode,
    url: page.url,
    title: page.title,
    capturedAt: page.capturedAt,
  }
  if (mode !== "metadata" && page.selection) {
    context.selection = markdownSelection
      ? { text: page.selection.markdown!, truncated: page.selection.truncated, format: "markdown" }
      : { text: page.selection.text, truncated: page.selection.truncated }
  }
  if (mode === "readable-page" && page.readableText) context.readableText = page.readableText
  if (mode === "article" && page.article) context.article = { ...page.article, format: "markdown" }
  if (features.includes("metadata") && page.metadata && Object.keys(page.metadata).length > 0) {
    context.metadata = page.metadata
  }
  if (features.includes("transcript") && page.transcript) context.transcript = page.transcript
  if (features.includes("link-image")) {
    if (page.link) context.link = page.link
    if (page.image) context.image = page.image
  }
  return context
}

/** Page content bytes one context contributes to the total budget (the Host's own count). */
export function contextContentBytes(context: BrowserPageContextV1): number {
  let bytes = 0
  if (context.selection) bytes += utf8ByteLength(context.selection.text)
  if (context.readableText) bytes += utf8ByteLength(context.readableText.text)
  if (context.article) bytes += utf8ByteLength(context.article.text)
  if (context.transcript?.status === "available") bytes += utf8ByteLength(context.transcript.text)
  return bytes
}

export type PagesCheck =
  | { ok: true; totalBytes: number }
  | { ok: false; reason: "too_many_pages" | "over_budget"; totalBytes: number }

/** Whether a set of contexts fits the Host's page count and total budget. */
export function checkPages(contexts: readonly BrowserPageContextV1[], limits: Limits): PagesCheck {
  const totalBytes = contexts.reduce((sum, context) => sum + contextContentBytes(context), 0)
  if (contexts.length > limits.maxPages) return { ok: false, reason: "too_many_pages", totalBytes }
  if (totalBytes > limits.totalContextBytes) return { ok: false, reason: "over_budget", totalBytes }
  return { ok: true, totalBytes }
}
