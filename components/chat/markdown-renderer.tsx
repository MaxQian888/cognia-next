"use client"

/**
 * MarkdownRenderer — full-featured markdown rendering for completed messages.
 *
 * Backed by react-markdown + CJK-aware GFM + remark-math + rehype-raw + rehype-sanitize,
 * with custom block renderers from `components/chat/renderers/*` for code, math,
 * mermaid, diff, images, video/audio, alerts, details, and kbd.
 *
 * Streaming text uses streamdown (see ai-elements/message MessageResponse).
 */

import { createContext, memo, useContext, useMemo } from "react"
import dynamic from "next/dynamic"
import { Skeleton } from "@/components/ui/skeleton"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import { cjk } from "@streamdown/cjk"
import { cn } from "@/lib/utils"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import type { ChatCodeThemeId, MessageMarkdownOptions } from "@/types/appearance"
import { resolveChatCodeTheme, type ChatCodeThemePair } from "@/lib/chat/code-theme"
import { withRendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { InlineMathLinkContext } from "@/components/chat/renderers/math-error-boundary"
import {
  createSharedMarkdownComponents,
  MarkdownInlineCode,
} from "@/components/chat/markdown/shared-components"
import {
  chatMarkdownSanitizeSchema,
  chatMarkdownUrlTransform,
  untrustedMarkdownUrlTransform,
} from "@/components/chat/markdown/rendering-policy"
import { ArtifactCreateButton } from "@/components/artifacts/artifact-create-button"
import { ChatLink } from "@/components/chat/markdown/chat-link"
import type { ProjectFileReference } from "@/lib/files/project-file-reference"

// `parseTaskListItem` moved to the shared factory alongside the `li` override
// that consumes it; re-exported here because it was part of this module's
// public surface (and its unit tests) before the extraction.
export { parseTaskListItem } from "@/components/chat/markdown/shared-components"

// Heavy block renderers are code-split via next/dynamic so the initial
// chat-tab bundle drops their parse cost. Mermaid is ~200KB minified,
// MathBlock/MathInline pull in KaTeX (~250KB), and Diff/A2UI follow the
// same lazy contract for consistency. Loading placeholders match the
// eventual block's visual footprint so the page doesn't shift when the
// chunk resolves. The local jest.mock for `next/dynamic` in the test file
// resolves these synchronously so existing `document.querySelector`
// assertions still work.
const MathBlock = dynamic(
  () => import("@/components/chat/renderers/math-block").then((m) => ({ default: m.MathBlock })),
  {
    ssr: false,
    loading: () => <Skeleton className="my-3 h-12" />,
  }
)

const MathInline = dynamic(
  () => import("@/components/chat/renderers/math-inline").then((m) => ({ default: m.MathInline })),
  {
    ssr: false,
    // Inline math also loads inside paragraphs and links. Skeleton renders a
    // div, so keep the same loading treatment on a phrasing element here.
    loading: () => (
      <span
        data-slot="skeleton"
        aria-hidden="true"
        className="inline-block h-4 w-12 animate-pulse rounded-md bg-accent"
      />
    ),
  }
)

const MermaidBlock = dynamic(
  () =>
    import("@/components/chat/renderers/mermaid-block").then((m) => ({ default: m.MermaidBlock })),
  {
    ssr: false,
    loading: () => <Skeleton className="my-3 h-32" />,
  }
)

// ADR-0218 — the inline ```chart block pulls in recharts, so it is split too.
const ChartBlock = dynamic(
  () => import("@/components/chat/renderers/chart-block").then((m) => ({ default: m.ChartBlock })),
  {
    ssr: false,
    loading: () => <Skeleton className="my-3 h-64" />,
  }
)

const DiffBlock = dynamic(
  () => import("@/components/chat/renderers/diff-block").then((m) => ({ default: m.DiffBlock })),
  {
    ssr: false,
    loading: () => <Skeleton className="my-3 h-16" />,
  }
)

const A2UIBlock = dynamic(
  () => import("@/components/chat/renderers/a2ui-block").then((m) => ({ default: m.A2UIBlock })),
  {
    ssr: false,
    loading: () => <Skeleton className="my-3 h-24" />,
  }
)

// Each non-trivial block renderer is wrapped in an error boundary so one
// malformed fence (bad mermaid graph, unparseable diff/a2ui, broken media
// URL) degrades to an inline error instead of unmounting the whole message.
// The math pair keeps its dedicated `withMathErrorBoundary`; everything else
// routes through the shared renderer boundary here. The image / video / audio
// / alert / details boundaries live in `markdown/shared-components.tsx` next
// to the overrides that use them.
const SafeMermaidBlock = withRendererErrorBoundary(MermaidBlock, "Mermaid")
const SafeDiffBlock = withRendererErrorBoundary(DiffBlock, "Diff")
const SafeChartBlock = withRendererErrorBoundary(ChartBlock, "Chart")
const SafeA2UIBlock = withRendererErrorBoundary(A2UIBlock, "A2UI")

type RemarkPlugins = NonNullable<Parameters<typeof ReactMarkdown>[0]["remarkPlugins"]>
type RehypePlugins = NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]>

// These plugin lists are immutable application configuration. Keeping them at
// module scope avoids rebuilding equivalent arrays for every rendered message.
// CJK's before/after ordering is load-bearing: emphasis parsing runs before GFM,
// while autolink punctuation and CJK strikethrough fixes run after it.
const baseRemarkPlugins: RemarkPlugins = [
  ...cjk.remarkPluginsBefore,
  remarkGfm,
  ...cjk.remarkPluginsAfter,
]
const mathRemarkPlugins: RemarkPlugins = [...baseRemarkPlugins, remarkMath]
const untrustedRemarkPlugins: RemarkPlugins = [...baseRemarkPlugins, remarkLimitUntrustedDepth]
const rehypePlugins: RehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, chatMarkdownSanitizeSchema],
  rehypeMarkdownHeadingIds,
]
// Without rehype-raw, react-markdown drops HTML in the source: no element
// (and no allow-listed `style`) from a third party reaches the DOM.
const rehypePluginsWithoutRawHtml: RehypePlugins = [
  [rehypeSanitize, chatMarkdownSanitizeSchema],
  rehypeMarkdownHeadingIds,
]

interface MarkdownAstNode {
  type?: string
  tagName?: string
  value?: string
  lang?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
}

/** Flatten external nesting before recursive Markdown-to-HTML conversion and React commit. */
export function limitUntrustedMarkdownDepth(tree: unknown, source: string): void {
  if (!tree || typeof tree !== "object") return
  const root = tree as MarkdownAstNode
  const pending = [{ node: root, depth: 0 }]
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (depth > 64) {
      // Preserve the complete source as literal text, rather than truncating
      // a quote or leaving a deeply nested DOM that cannot be safely unmounted.
      root.children = [{ type: "code", lang: "text", value: source }]
      return
    }
    for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 })
  }
}

function remarkLimitUntrustedDepth() {
  return (tree: unknown, file: { toString(): string }) =>
    limitUntrustedMarkdownDepth(tree, file.toString())
}

function markdownNodeText(node: MarkdownAstNode): string {
  if (node.type === "text") return node.value ?? ""
  return node.children?.map(markdownNodeText).join("") ?? ""
}

function markdownHeadingSlug(value: string): string {
  return value
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/**
 * Add GitHub-style ids to Markdown headings so fragment links work without a
 * runtime dependency. This transformer runs after sanitization and only for
 * completed messages, keeping it out of the per-token streaming path.
 */
export function addMarkdownHeadingIds(tree: unknown): void {
  if (!tree || typeof tree !== "object") return
  const seen = new Map<string, number>()

  const visit = (node: MarkdownAstNode) => {
    if (/^h[1-6]$/.test(node.tagName ?? "")) {
      const existingId = typeof node.properties?.id === "string" ? node.properties.id : undefined
      if (existingId) {
        seen.set(existingId, Math.max(seen.get(existingId) ?? 0, 1))
      } else {
        const base = markdownHeadingSlug(markdownNodeText(node))
        if (base) {
          const duplicateIndex = seen.get(base) ?? 0
          node.properties = {
            ...node.properties,
            id: duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`,
          }
          seen.set(base, duplicateIndex + 1)
        }
      }
    }
    node.children?.forEach(visit)
  }

  visit(tree as MarkdownAstNode)
}

function rehypeMarkdownHeadingIds() {
  return addMarkdownHeadingIds
}

/**
 * Convert `\[...\]` → `$$...$$` and `\(...\)` → `$...$` so remark-math accepts
 * the wider variety of LaTeX delimiters Claude tends to emit.
 */
function preprocessLatex(content: string): string {
  let processed = content
  if (processed.includes("\\[")) {
    processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_match, eq) => `$$${eq}$$`)
  }
  if (processed.includes("\\(")) {
    processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_match, eq) => `$${eq}$`)
  }
  return processed
}

export interface MarkdownRendererProps {
  content: string
  className?: string
  /**
   * ADR-0127 — the resolved `messageDisplay.markdown` knobs. Seeds
   * `enableMath` / `enableMermaid` / `enableDiff` / `showLineNumbers` /
   * `wrapLines` / `mathFontScale` / `mathDisplayAlignment` /
   * `mathShowCopyButton`; an explicitly passed individual prop still wins, so
   * non-chat callers (plugin READMEs, skill docs) keep their overrides.
   */
  markdown?: MessageMarkdownOptions
  enableMermaid?: boolean
  enableMath?: boolean
  enableDiff?: boolean
  /** ADR-0218 — draw ```chart fences inline; off ⇒ shown as code. */
  enableCharts?: boolean
  enableAlerts?: boolean
  enableEnhancedImages?: boolean
  enableVideoEmbed?: boolean
  enableAudioEmbed?: boolean
  showLineNumbers?: boolean
  /** Default soft-wrap for code blocks (per-block toolbar can still toggle). */
  wrapLines?: boolean
  mathFontScale?: number
  mathDisplayAlignment?: "center" | "left"
  mathShowCopyButton?: boolean
  /** ADR-0218 — syntax theme pair id; both branches resolve the same pair. */
  codeThemeId?: ChatCodeThemeId
  /**
   * Source message id used to attribute manually-created artifacts back to a
   * specific assistant message; passed through to the per-block
   * `ArtifactCreateButton`.
   */
  messageId?: string
  /**
   * When the host message is mid-stream, code blocks short-circuit the
   * async Shiki highlight path and render plain `<pre>`. The full Shiki
   * pass kicks in once streaming finalises and `MessageRenderer` flips
   * the branch from `<StreamingTextPart>` to `<MarkdownRenderer>`.
   */
  isStreaming?: boolean
  /**
   * Which typeset preset this surface reads.
   *
   * `"chat"` (the default, and what every assistant turn uses) tightens leading
   * and block flow — `app/typeset.css` justifies it as "a turn is a
   * conversation, not an article". `"document"` keeps typeset's own article
   * rhythm and is what the long-form surfaces want: plugin READMEs, skill docs
   * and the skill preview, which is where the Tailwind `prose` classes used to
   * do this job.
   */
  rhythm?: "chat" | "document"
  /** Root used to resolve workspace-relative Markdown file links. */
  projectRoot?: string | null
  /** Optional owner override, used when opening a file must first mount an editor tab. */
  onOpenProjectFile?: (target: ProjectFileReference) => void
  /**
   * Markdown written by a third party (an inbound IM message or card), not
   * by the user or the assistant. Raw HTML is dropped instead of parsed (the
   * sanitize schema keeps `style` on `div` / `span`, enough for a sender to
   * overlay the app), ```a2ui fences show as code instead of mutating A2UI
   * surfaces, links are limited to web / mail targets
   * (`untrustedMarkdownUrlTransform`), paths in code never become file links,
   * and math is off (`$5 and $10`, an escaped `\[x\]` are text). Defaults to
   * `false`.
   */
  untrusted?: boolean
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
  markdown,
  enableMermaid = markdown?.mermaid ?? true,
  enableMath: requestedMath = markdown?.math ?? true,
  enableDiff = markdown?.diff ?? true,
  enableCharts = markdown?.charts ?? true,
  enableAlerts = true,
  enableEnhancedImages = true,
  enableVideoEmbed = true,
  enableAudioEmbed = true,
  showLineNumbers = markdown?.codeLineNumbers ?? true,
  wrapLines = markdown?.codeWrap ?? false,
  mathFontScale = markdown?.mathFontScale ?? 1,
  mathDisplayAlignment = markdown?.mathAlign ?? "center",
  mathShowCopyButton = markdown?.mathCopy ?? true,
  codeThemeId = markdown?.codeTheme,
  messageId,
  isStreaming = false,
  rhythm = "chat",
  projectRoot,
  onOpenProjectFile,
  untrusted = false,
}: MarkdownRendererProps) {
  // A third party's `$5 and $10` or escaped `\[x\]` is not LaTeX.
  const enableMath = untrusted ? false : requestedMath
  const remarkPlugins = untrusted
    ? untrustedRemarkPlugins
    : enableMath
      ? mathRemarkPlugins
      : baseRemarkPlugins

  const processedContent = useMemo(() => {
    return enableMath ? preprocessLatex(content) : content
  }, [content, enableMath])

  const components = useMemo(
    () =>
      buildComponents({
        enableMermaid,
        enableMath,
        enableDiff,
        enableCharts,
        enableAlerts,
        enableEnhancedImages,
        enableVideoEmbed,
        enableAudioEmbed,
        showLineNumbers,
        wrapLines,
        mathFontScale,
        mathDisplayAlignment,
        mathShowCopyButton,
        codeTheme: resolveChatCodeTheme(codeThemeId),
        messageId,
        isStreaming,
        // A third party must not open files in the user's project.
        projectRoot: untrusted ? undefined : projectRoot,
        onOpenProjectFile: untrusted ? undefined : onOpenProjectFile,
        untrusted,
      }),
    [
      enableMermaid,
      enableMath,
      enableDiff,
      enableCharts,
      enableAlerts,
      enableEnhancedImages,
      enableVideoEmbed,
      enableAudioEmbed,
      showLineNumbers,
      wrapLines,
      mathFontScale,
      mathDisplayAlignment,
      mathShowCopyButton,
      codeThemeId,
      messageId,
      isStreaming,
      projectRoot,
      onOpenProjectFile,
      untrusted,
    ]
  )

  return (
    <div
      className={cn("markdown-renderer typeset", rhythm === "chat" && "typeset-chat", className)}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={untrusted ? rehypePluginsWithoutRawHtml : rehypePlugins}
        components={components}
        urlTransform={untrusted ? untrustedMarkdownUrlTransform : chatMarkdownUrlTransform}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  )
})

MarkdownRenderer.displayName = "MarkdownRenderer"

interface BuildComponentsOptions {
  enableMermaid: boolean
  enableMath: boolean
  enableDiff: boolean
  enableCharts: boolean
  enableAlerts: boolean
  enableEnhancedImages: boolean
  enableVideoEmbed: boolean
  enableAudioEmbed: boolean
  showLineNumbers: boolean
  wrapLines: boolean
  mathFontScale: number
  mathDisplayAlignment: "center" | "left"
  mathShowCopyButton: boolean
  codeTheme: ChatCodeThemePair
  messageId?: string
  isStreaming: boolean
  projectRoot?: string | null
  onOpenProjectFile?: (target: ProjectFileReference) => void
  untrusted: boolean
}

// Language classes and terminal newlines can also appear on inline HTML code.
// Only a surrounding <pre> grants permission to mount a block renderer.
const MarkdownCodeBlockContext = createContext(false)

function buildComponents(
  opts: BuildComponentsOptions
): NonNullable<Parameters<typeof ReactMarkdown>[0]["components"]> {
  const {
    enableMermaid,
    enableMath,
    enableDiff,
    enableCharts,
    enableAlerts,
    enableEnhancedImages,
    enableVideoEmbed,
    enableAudioEmbed,
    showLineNumbers,
    wrapLines,
    mathFontScale,
    mathDisplayAlignment,
    mathShowCopyButton,
    codeTheme,
    messageId,
    isStreaming,
    projectRoot,
    onOpenProjectFile,
    untrusted,
  } = opts

  return {
    // Everything both markdown surfaces agree on. Spread first so the
    // branch-specific overrides below win on conflict.
    ...createSharedMarkdownComponents({
      enableEnhancedImages,
      enableAlerts,
      enableVideoEmbed,
      enableAudioEmbed,
      isStreaming,
    }),
    // Every block renderer reached from here paints its own `<pre>` or
    // `<table>` — Shiki's fence, KaTeX's display math, Mermaid's source
    // fallback, the diff table. typeset's element rules are an unbounded
    // descendant match, so each one is wrapped in `not-typeset` at its mount
    // rather than at its root: these components have two to four return
    // branches each, and the mount is the one place that covers all of them.
    code: function MarkdownCode({ className: codeClassName, children }) {
      const isBlock = useContext(MarkdownCodeBlockContext)
      const match = /(?:^|\s)language-([^\s]+)/.exec(codeClassName || "")
      const language = match ? match[1] : undefined
      const rawCodeContent = String(children)
      const codeContent = rawCodeContent.replace(/\n$/, "")

      // remark-math emits code elements with `language-math` and an
      // additional `math-display` / `math-inline` class.
      if (enableMath && language === "math") {
        if (isBlock) {
          return (
            <div className="not-typeset">
              <MathBlock
                content={codeContent}
                scale={mathFontScale}
                alignment={mathDisplayAlignment}
              />
            </div>
          )
        }
        return (
          <MathInline
            content={codeContent}
            scale={mathFontScale}
            showCopyOnHover={mathShowCopyButton}
          />
        )
      }

      if (!isBlock) {
        return (
          <MarkdownInlineCode
            projectRoot={projectRoot}
            onOpenProjectFile={onOpenProjectFile}
            linkFiles={!untrusted}
          >
            {children}
          </MarkdownInlineCode>
        )
      }

      if (enableMermaid && language === "mermaid") {
        return (
          <div className="not-typeset">
            <SafeMermaidBlock content={codeContent} />
          </div>
        )
      }

      if (enableDiff && language === "diff") {
        return (
          <div className="not-typeset">
            <SafeDiffBlock content={codeContent} />
          </div>
        )
      }

      if (enableCharts && language === "chart") {
        return (
          <div className="not-typeset">
            <SafeChartBlock content={codeContent} />
          </div>
        )
      }

      if (language === "a2ui" && !untrusted) {
        return (
          <div className="not-typeset">
            <SafeA2UIBlock content={codeContent} messageId={messageId} />
          </div>
        )
      }

      // The artifact button joins the block's own toolbar (ADR-0218); it used
      // to float over the header and cover its last two actions.
      const showArtifactButton = codeContent.includes("\n")
      return (
        <div className="not-typeset">
          <CodeBlock
            code={codeContent}
            language={language}
            showLineNumbers={showLineNumbers}
            wrapLines={wrapLines}
            isStreaming={isStreaming}
            theme={codeTheme}
            capHeight
            extraActions={
              showArtifactButton ? (
                <ArtifactCreateButton
                  content={codeContent}
                  language={language}
                  messageId={messageId}
                  variant="icon"
                  className="size-6 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
                />
              ) : null
            }
          />
        </div>
      )
    },
    pre({ children }) {
      return (
        <MarkdownCodeBlockContext.Provider value={true}>
          {children}
        </MarkdownCodeBlockContext.Provider>
      )
    },
    a({ href, children }) {
      return (
        <InlineMathLinkContext.Provider value={true}>
          <ChatLink
            href={href}
            projectRoot={projectRoot}
            onOpenProjectFile={onOpenProjectFile}
            messageId={messageId}
            isStreaming={isStreaming}
          >
            {children}
          </ChatLink>
        </InlineMathLinkContext.Provider>
      )
    },
  }
}
