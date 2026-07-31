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
 *      per token, but pairs with Stage 4's heavy-block lazy-load + Stage 6's
 *      `<Activity>` to keep the streaming subtree minimal.
 *
 * Pairs with the non-streaming text branch in `MessageRenderer`, which
 * routes through `<MarkdownRenderer>` for the finalised message.
 */

import { memo, useMemo, useState } from "react"
import { Block, parseMarkdownIntoBlocks, type BlockProps } from "streamdown"
import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message"
import { createSharedMarkdownComponents } from "@/components/chat/markdown/shared-components"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { ProjectFileLink } from "@/components/chat/project-file-link"
import { ExternalLink } from "@/components/shared/external-link"
import { parseProjectFileReference } from "@/lib/files/project-file-reference"
import { cn } from "@/lib/utils"
import {
  createIncrementalMarkdownBlockParser,
  type MarkdownBlockParser,
} from "./incremental-markdown-blocks"

interface Props {
  text: string
  isStreaming: boolean
  projectRoot?: string | null
}

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

const ContainedStreamdownBlock = memo(function ContainedStreamdownBlock(props: BlockProps) {
  return (
    <div
      className={cn(
        "[content-visibility:auto] [contain-intrinsic-size:auto_160px]",
        blockRendersCode((props as { content?: unknown }).content) && "not-typeset"
      )}
    >
      <Block {...props} />
    </div>
  )
})

type StreamdownComponents = NonNullable<MessageResponseProps["components"]>

function createStreamingComponents(projectRoot?: string | null): StreamdownComponents {
  return {
    // Shared with `MarkdownRenderer` so images, tables, GitHub alerts,
    // `<details>`, `<kbd>` and task lists don't visually re-lay-out the moment
    // the turn finalises and the renderer swaps branches.
    //
    // Two deliberate omissions:
    //   - `code` / `pre` stay with `@streamdown/code` (theme-aligned in
    //     `ai-elements/streamdown-plugins.ts`) so incremental highlighting
    //     survives.
    //   - No `rehype-raw` runs here, so `<details>` / `<kbd>` written as raw
    //     HTML only pick these up once the message finalises. Markdown-syntax
    //     nodes hit them immediately. Keeping raw-HTML parsing off the
    //     per-token path is a cost/attack-surface choice, not an oversight.
    ...createSharedMarkdownComponents(),
    a({ href, children, node: _node, ...props }) {
      const target = href ? parseProjectFileReference(href, projectRoot) : null
      if (target) {
        return <ProjectFileLink target={target}>{children}</ProjectFileLink>
      }
      return (
        <ExternalLink href={href ?? ""} className="text-primary hover:underline" {...props}>
          {children}
        </ExternalLink>
      )
    },
  }
}

function StreamingTextPartInner({ text, projectRoot }: Props) {
  const [parser] = useState<MarkdownBlockParser>(() =>
    createIncrementalMarkdownBlockParser(parseMarkdownIntoBlocks)
  )
  const components = useMemo(() => createStreamingComponents(projectRoot), [projectRoot])
  // Reduced motion: a static (non-blinking) caret so we still signal "more is
  // coming" without an animation. `animate-pulse` is a guaranteed Tailwind
  // utility (no dependency on `animate-caret-blink`).
  const { reduce } = useFlowMotion()
  return (
    <>
      <MessageResponse
        BlockComponent={ContainedStreamdownBlock}
        className="typeset typeset-chat"
        components={components}
        mode="streaming"
        parseMarkdownIntoBlocksFn={parser}
      >
        {text}
      </MessageResponse>
      <span
        aria-hidden
        data-testid="streaming-caret"
        className={cn(
          "ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 rounded-full bg-foreground/60 align-middle",
          !reduce && "animate-pulse"
        )}
      />
    </>
  )
}

export const StreamingTextPart = memo(
  StreamingTextPartInner,
  (prev, next) =>
    prev.text === next.text &&
    prev.isStreaming === next.isStreaming &&
    prev.projectRoot === next.projectRoot
)
StreamingTextPart.displayName = "StreamingTextPart"
