"use client"

/**
 * `<StreamingTextPart>` — narrow subtree owning Streamdown's `MessageResponse`
 * for the actively-streaming text branch of `MessageRenderer`. Extracted so:
 *
 *   1. Streamdown's own transition remains at a tight boundary while its
 *      block parser reuses the stable prefix of an append-only response.
 *   2. The outer `MessageRenderer` body (header, mentions, avatar, plugin
 *      slots, action bar) stays out of the per-token render path conceptually.
 *      The memo equality on (text, isStreaming) is a no-op when text changes
 *      per token, but pairs with the heavy-block `next/dynamic` lazy-load in
 *      `markdown-renderer.tsx` to keep the streaming subtree minimal. (An
 *      earlier plan mentioned React `<Activity>`; it was never adopted here —
 *      ADR-0127. The per-block `content-visibility` wrapper that used to live
 *      here is gone — ADR-0138; only settled messages skip render now.)
 *
 * Pairs with the non-streaming text branch in `MessageRenderer`, which
 * routes through `<MarkdownRenderer>` for the finalised message.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { Block, parseMarkdownIntoBlocks, type BlockProps } from "streamdown"
import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message"
import { createSharedMarkdownComponents } from "@/components/chat/markdown/shared-components"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { ProjectFileLink } from "@/components/chat/project-file-link"
import { ExternalLink } from "@/components/shared/external-link"
import { parseProjectFileReference } from "@/lib/files/project-file-reference"
import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "./markdown-renderer"
import { chatMarkdownUrlTransform, chatStreamdownRehypePlugins } from "./markdown/rendering-policy"
import type { MessageMarkdownOptions, MessageRichControls } from "@/types/appearance"
import { selectStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"
import {
  createIncrementalMarkdownBlockParser,
  type MarkdownBlockParser,
} from "./incremental-markdown-blocks"

interface Props {
  text: string
  isStreaming: boolean
  projectRoot?: string | null
  richControls?: MessageRichControls
  /** ADR-0127 — resolved `messageDisplay.markdown` knobs (both renderers read them). */
  markdown?: MessageMarkdownOptions
}

interface FinalizedProps {
  text: string
  messageId?: string
  projectRoot?: string | null
  markdown?: MessageMarkdownOptions
}

export const FINALIZED_MARKDOWN_LAZY_THRESHOLD = 64 * 1024
const FINALIZED_BLOCKS_PER_SECTION = 8
const FINALIZED_EAGER_SECTIONS = 3

/** A fence opening at the start of any line, allowing CommonMark's ≤3 spaces of
 *  indentation and the extra indentation a list item or blockquote adds. */
const FENCE_LINE = /^[ \t>]*(?:```|~~~)/m

/**
 * Will this markdown block render a `<pre>` that typeset must not restyle?
 *
 * The streaming branch deliberately leaves `code`/`pre` to `@streamdown/code`
 * (see `createStreamingComponents` below), so there is no component override to
 * hang typeset's opt-out marker on — and typeset's element rules are an
 * unbounded descendant match that would otherwise repaint Streamdown's `<pre>`
 * with its own background, padding and font size. The block wrapper is the one
 * seam we own on that path.
 *
 * Matching only blocks that *open* with a fence was not enough: a fence inside
 * a list item or a blockquote, and an indented code block, all render a `<pre>`
 * the finalised `MarkdownRenderer` styles through its own `code`/`pre`
 * overrides. Missing them is exactly the finalise-time jump the streaming
 * parity work set out to remove — the block was typeset-styled while streaming
 * and swapped the instant the turn ended.
 *
 * Indented code is only claimed when the *whole* block is indented. A list
 * whose continuation lines sit at four spaces would otherwise be marked, and
 * losing typeset's rhythm on ordinary prose is the worse error of the two.
 *
 * Exported for tests: the streamdown module is stubbed there, so the predicate
 * cannot be reached through a real block parse.
 */
export function blockRendersCode(content: unknown): boolean {
  if (typeof content !== "string") return false
  if (FENCE_LINE.test(content)) return true
  const lines = content.split("\n").filter((line) => line.trim() !== "")
  return lines.length > 0 && lines.every((line) => /^(?: {4}|\t)/.test(line))
}

/**
 * Per-block wrapper for the STREAMING branch. It exists for one reason: to hang
 * typeset's opt-out on a block that renders a `<pre>` (see
 * {@link blockRendersCode}).
 *
 * It used to also carry `content-visibility: auto` with a
 * `contain-intrinsic-size: auto 160px` placeholder. That is wrong on this path
 * and was a jitter source (ADR-0138): every block of the reply being streamed is
 * on screen, so skipping render buys nothing — but the row IS measured, so each
 * block flipping between rendered and skipped changes the row's height, which
 * re-publishes the virtualizer's offsets, which moves the block, which flips it
 * again. On first render it is worse still: the remembered size replaces the
 * 160px guess, so every block lands with a height correction under the caret.
 *
 * Settled messages keep it — `FinalizedMarkdownSection` above — where blocks
 * genuinely do leave the viewport and their remembered sizes are already true.
 */
const StreamingBlock = memo(function StreamingBlock(props: BlockProps) {
  const rendersCode = blockRendersCode((props as { content?: unknown }).content)
  if (!rendersCode) return <Block {...props} />
  return (
    <div className="not-typeset">
      <Block {...props} />
    </div>
  )
})

function FinalizedMarkdownSection({
  content,
  eager,
  messageId,
  projectRoot,
  markdown,
}: {
  content: string
  eager: boolean
  messageId?: string
  projectRoot?: string | null
  markdown?: MessageMarkdownOptions
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(eager)

  useEffect(() => {
    if (visible || eager) return
    const element = rootRef.current
    if (!element) return
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisible(true)
        observer.disconnect()
      },
      { rootMargin: "1200px 0px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [eager, visible])

  return (
    <div
      ref={rootRef}
      data-testid={visible ? "finalized-markdown-section" : "finalized-markdown-placeholder"}
      className="[content-visibility:auto] [contain-intrinsic-size:auto_320px]"
    >
      {visible ? (
        <MarkdownRenderer
          content={content}
          messageId={messageId}
          projectRoot={projectRoot}
          markdown={markdown}
          className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      ) : null}
    </div>
  )
}

/**
 * Finalized long-form Markdown keeps the authoritative sanitized renderer, but
 * mounts parsed block groups only as they approach the viewport.
 */
export const FinalizedLongTextPart = memo(function FinalizedLongTextPart({
  text,
  messageId,
  projectRoot,
  markdown,
}: FinalizedProps) {
  const sections = useMemo(() => {
    const blocks = parseMarkdownIntoBlocks(text)
    const grouped: string[] = []
    for (let index = 0; index < blocks.length; index += FINALIZED_BLOCKS_PER_SECTION) {
      grouped.push(blocks.slice(index, index + FINALIZED_BLOCKS_PER_SECTION).join(""))
    }
    return grouped
  }, [text])

  return sections.map((content, index) => (
    <FinalizedMarkdownSection
      key={`${index}:${content.length}`}
      content={content}
      eager={index < FINALIZED_EAGER_SECTIONS}
      messageId={messageId}
      projectRoot={projectRoot}
      markdown={markdown}
    />
  ))
})

type StreamdownComponents = NonNullable<MessageResponseProps["components"]>

export function createStreamingComponents(
  projectRoot?: string | null,
  isStreaming = false
): StreamdownComponents {
  return {
    // Shared with `MarkdownRenderer` so images, tables, GitHub alerts,
    // `<details>`, `<kbd>` and task lists don't visually re-lay-out the moment
    // the turn finalises and the renderer swaps branches.
    //
    // Two deliberate omissions:
    //   - `code` / `pre` stay with `@streamdown/code` (theme-aligned in
    //     `ai-elements/streamdown-plugins.ts`) so incremental highlighting
    //     survives.
    // Raw HTML is parsed by Streamdown and then constrained by the shared
    // chat sanitization policy supplied to `MessageResponse` below.
    ...createSharedMarkdownComponents({ isStreaming }),
    a({ href, children, node: _node, ...props }) {
      const target = href ? parseProjectFileReference(href, projectRoot) : null
      if (target) {
        return (
          <ProjectFileLink target={target} projectRoot={projectRoot}>
            {children}
          </ProjectFileLink>
        )
      }
      return (
        <ExternalLink href={href ?? ""} className="text-primary hover:underline" {...props}>
          {children}
        </ExternalLink>
      )
    },
  }
}

function StreamingTextPartInner({
  text,
  isStreaming,
  projectRoot,
  richControls = "hover",
  markdown,
}: Props) {
  const [parser] = useState<MarkdownBlockParser>(() =>
    createIncrementalMarkdownBlockParser(parseMarkdownIntoBlocks)
  )
  const components = useMemo(
    () => createStreamingComponents(projectRoot, isStreaming),
    [isStreaming, projectRoot]
  )
  // ADR-0127: the same resolved knobs the finalized branch reads. Plugin
  // variants are prebuilt (stable identity); `lineNumbers` is a Streamdown
  // prop; soft-wrap has no Streamdown prop, so it is applied to the fenced
  // `<pre>` through the wrapper class the code plugin renders into.
  const plugins = selectStreamdownPlugins(markdown)
  const lineNumbers = markdown?.codeLineNumbers ?? true
  const codeWrap = markdown?.codeWrap ?? false
  // ADR-0138 — the caret is Streamdown's own (`caret="block"`), not a hand-rolled
  // element. Ours was a sibling of `<MessageResponse>` inside `MessageContent`'s
  // flex column, so it held a permanent 16px row plus an 8px gap under the reply
  // for the whole turn and vanished in one 24px step when the turn sealed.
  // Streamdown renders `▋` as an `::after` on the last block: inline, at the end
  // of the last text node, contributing no box of its own — and it suppresses
  // itself inside an unclosed code fence, which the sibling span never did.
  //
  // Reduced motion keeps the caret and drops only the blink, so "more is coming"
  // still reads without an animation. `animate-pulse` is a guaranteed Tailwind
  // utility (no dependency on `animate-caret-blink`).
  const { reduce } = useFlowMotion()
  return (
    <MessageResponse
      BlockComponent={StreamingBlock}
      caret="block"
      className={cn(
        "typeset typeset-chat",
        codeWrap && "[&_pre]:whitespace-pre-wrap",
        !reduce && "[&>*:last-child]:after:animate-pulse"
      )}
      components={components}
      controls={richControls === "hidden" ? false : { table: false }}
      data-rich-controls={richControls}
      isAnimating={isStreaming}
      lineNumbers={lineNumbers}
      mode="streaming"
      parseMarkdownIntoBlocksFn={parser}
      plugins={plugins}
      rehypePlugins={chatStreamdownRehypePlugins}
      urlTransform={chatMarkdownUrlTransform}
    >
      {text}
    </MessageResponse>
  )
}

export const StreamingTextPart = memo(
  StreamingTextPartInner,
  (prev, next) =>
    prev.text === next.text &&
    prev.isStreaming === next.isStreaming &&
    prev.projectRoot === next.projectRoot &&
    prev.richControls === next.richControls &&
    prev.markdown === next.markdown
)
StreamingTextPart.displayName = "StreamingTextPart"
