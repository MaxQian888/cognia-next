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

import { memo, useMemo } from "react"
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
import { withRendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { createSharedMarkdownComponents } from "@/components/chat/markdown/shared-components"
import {
  chatMarkdownSanitizeSchema,
  chatMarkdownUrlTransform,
} from "@/components/chat/markdown/rendering-policy"
import { ArtifactCreateButton } from "@/components/artifacts/artifact-create-button"
import { ExternalLink } from "@/components/shared/external-link"
import { ProjectFileLink } from "@/components/chat/project-file-link"
import {
  parseProjectFileReference,
  type ProjectFileReference,
} from "@/lib/files/project-file-reference"

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
    loading: () => <Skeleton className="inline-block h-4 w-12" />,
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
const rehypePlugins: RehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, chatMarkdownSanitizeSchema],
  rehypeMarkdownHeadingIds,
]

interface MarkdownAstNode {
  type?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
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
  enableMermaid?: boolean
  enableMath?: boolean
  enableDiff?: boolean
  enableAlerts?: boolean
  enableEnhancedImages?: boolean
  enableVideoEmbed?: boolean
  enableAudioEmbed?: boolean
  showLineNumbers?: boolean
  mathFontScale?: number
  mathDisplayAlignment?: "center" | "left"
  mathShowCopyButton?: boolean
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
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
  enableMermaid = true,
  enableMath = true,
  enableDiff = true,
  enableAlerts = true,
  enableEnhancedImages = true,
  enableVideoEmbed = true,
  enableAudioEmbed = true,
  showLineNumbers = true,
  mathFontScale = 1,
  mathDisplayAlignment = "center",
  mathShowCopyButton = true,
  messageId,
  isStreaming = false,
  rhythm = "chat",
  projectRoot,
  onOpenProjectFile,
}: MarkdownRendererProps) {
  const remarkPlugins = enableMath ? mathRemarkPlugins : baseRemarkPlugins

  const processedContent = useMemo(() => {
    return enableMath ? preprocessLatex(content) : content
  }, [content, enableMath])

  const components = useMemo(
    () =>
      buildComponents({
        enableMermaid,
        enableMath,
        enableDiff,
        enableAlerts,
        enableEnhancedImages,
        enableVideoEmbed,
        enableAudioEmbed,
        showLineNumbers,
        mathFontScale,
        mathDisplayAlignment,
        mathShowCopyButton,
        messageId,
        isStreaming,
        projectRoot,
        onOpenProjectFile,
      }),
    [
      enableMermaid,
      enableMath,
      enableDiff,
      enableAlerts,
      enableEnhancedImages,
      enableVideoEmbed,
      enableAudioEmbed,
      showLineNumbers,
      mathFontScale,
      mathDisplayAlignment,
      mathShowCopyButton,
      messageId,
      isStreaming,
      projectRoot,
      onOpenProjectFile,
    ]
  )

  return (
    <div
      className={cn("markdown-renderer typeset", rhythm === "chat" && "typeset-chat", className)}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={chatMarkdownUrlTransform}
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
  enableAlerts: boolean
  enableEnhancedImages: boolean
  enableVideoEmbed: boolean
  enableAudioEmbed: boolean
  showLineNumbers: boolean
  mathFontScale: number
  mathDisplayAlignment: "center" | "left"
  mathShowCopyButton: boolean
  messageId?: string
  isStreaming: boolean
  projectRoot?: string | null
  onOpenProjectFile?: (target: ProjectFileReference) => void
}

function buildComponents(
  opts: BuildComponentsOptions
): NonNullable<Parameters<typeof ReactMarkdown>[0]["components"]> {
  const {
    enableMermaid,
    enableMath,
    enableDiff,
    enableAlerts,
    enableEnhancedImages,
    enableVideoEmbed,
    enableAudioEmbed,
    showLineNumbers,
    mathFontScale,
    mathDisplayAlignment,
    mathShowCopyButton,
    messageId,
    isStreaming,
    projectRoot,
    onOpenProjectFile,
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
    code({ className: codeClassName, children, ...props }) {
      const match = /(?:^|\s)language-([^\s]+)/.exec(codeClassName || "")
      const language = match ? match[1] : undefined
      const rawCodeContent = String(children)
      // react-markdown preserves a terminal newline for block code, including
      // one-line fences without a language. Inline code has no terminal newline.
      const isInline = !match && !rawCodeContent.endsWith("\n")
      const codeContent = rawCodeContent.replace(/\n$/, "")

      // remark-math emits code elements with `language-math` and an
      // additional `math-display` / `math-inline` class.
      if (enableMath && language === "math") {
        const isDisplayMath = codeClassName?.includes("math-display")
        if (isDisplayMath) {
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

      if (isInline) {
        const target = parseProjectFileReference(codeContent, projectRoot)
        if (target) {
          return (
            <ProjectFileLink target={target} onOpenFile={onOpenProjectFile}>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono" {...props}>
                {children}
              </code>
            </ProjectFileLink>
          )
        }
        // No `text-sm`: typeset sizes inline code at 0.85em, so it tracks
        // whichever preset the surrounding container carries instead of
        // pinning 14px into a compact tool card and a full-width README alike.
        return (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono" {...props}>
            {children}
          </code>
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

      if (language === "a2ui") {
        return (
          <div className="not-typeset">
            <SafeA2UIBlock content={codeContent} messageId={messageId} />
          </div>
        )
      }

      const showArtifactButton = codeContent.includes("\n")
      return (
        <div className="not-typeset relative group/code">
          <CodeBlock
            code={codeContent}
            language={language}
            showLineNumbers={showLineNumbers}
            isStreaming={isStreaming}
          />
          {showArtifactButton && (
            <div className="absolute right-1 top-1 opacity-0 group-hover/code:opacity-100 transition-opacity">
              <ArtifactCreateButton
                content={codeContent}
                language={language}
                messageId={messageId}
                variant="icon"
              />
            </div>
          )}
        </div>
      )
    },
    pre({ children }) {
      return <>{children}</>
    },
    a({ href, children }) {
      const target = href ? parseProjectFileReference(href, projectRoot) : null
      if (target) {
        return (
          <ProjectFileLink target={target} onOpenFile={onOpenProjectFile}>
            {children}
          </ProjectFileLink>
        )
      }
      // `ExternalLink` keeps `target="_blank"` on web but routes http(s) clicks
      // through `openExternal` on Capacitor/Tauri (the WebView can't rely on
      // `target="_blank"` — Android blocks new-window creation, WKWebView is
      // inconsistent). Non-http hrefs (anchors, mailto:) pass through untouched.
      return (
        <ExternalLink href={href ?? ""} className="text-primary hover:underline">
          {children}
        </ExternalLink>
      )
    },
  }
}
