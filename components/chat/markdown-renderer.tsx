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

import { memo, useMemo, isValidElement, Children } from "react"
import dynamic from "next/dynamic"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import { cjk } from "@streamdown/cjk"
import { cn } from "@/lib/utils"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { VideoBlock } from "@/components/chat/renderers/video-block"
import { AudioBlock } from "@/components/chat/renderers/audio-block"
import { AlertBlock, parseAlertFromBlockquote } from "@/components/chat/renderers/alert-block"
import { DetailsBlock } from "@/components/chat/renderers/details-block"
import { KbdInline } from "@/components/chat/renderers/kbd-inline"
import { TaskListItem } from "@/components/chat/renderers/task-list"
import { withRendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { ArtifactCreateButton } from "@/components/artifacts/artifact-create-button"
import { ExternalLink } from "@/components/shared/external-link"
import { ProjectFileLink } from "@/components/chat/project-file-link"
import {
  parseProjectFileReference,
  type ProjectFileReference,
} from "@/lib/files/project-file-reference"

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
    loading: () => <div className="my-3 h-12 animate-pulse rounded bg-muted" aria-hidden="true" />,
  }
)

const MathInline = dynamic(
  () => import("@/components/chat/renderers/math-inline").then((m) => ({ default: m.MathInline })),
  {
    ssr: false,
    loading: () => (
      <span className="inline-block h-4 w-12 animate-pulse rounded bg-muted" aria-hidden="true" />
    ),
  }
)

const MermaidBlock = dynamic(
  () =>
    import("@/components/chat/renderers/mermaid-block").then((m) => ({ default: m.MermaidBlock })),
  {
    ssr: false,
    loading: () => <div className="my-3 h-32 animate-pulse rounded bg-muted" aria-hidden="true" />,
  }
)

const DiffBlock = dynamic(
  () => import("@/components/chat/renderers/diff-block").then((m) => ({ default: m.DiffBlock })),
  {
    ssr: false,
    loading: () => <div className="my-3 h-16 animate-pulse rounded bg-muted" aria-hidden="true" />,
  }
)

const A2UIBlock = dynamic(
  () => import("@/components/chat/renderers/a2ui-block").then((m) => ({ default: m.A2UIBlock })),
  {
    ssr: false,
    loading: () => <div className="my-3 h-24 animate-pulse rounded bg-muted" aria-hidden="true" />,
  }
)

// Each non-trivial block renderer is wrapped in an error boundary so one
// malformed fence (bad mermaid graph, unparseable diff/a2ui, broken media
// URL) degrades to an inline error instead of unmounting the whole message.
// The math pair keeps its dedicated `withMathErrorBoundary`; everything else
// routes through the shared renderer boundary here.
const SafeMermaidBlock = withRendererErrorBoundary(MermaidBlock, "Mermaid")
const SafeDiffBlock = withRendererErrorBoundary(DiffBlock, "Diff")
const SafeA2UIBlock = withRendererErrorBoundary(A2UIBlock, "A2UI")
const SafeAlertBlock = withRendererErrorBoundary(AlertBlock, "Alert")
const SafeDetailsBlock = withRendererErrorBoundary(DetailsBlock, "Details")
const SafeImageBlock = withRendererErrorBoundary(ImageBlock, "Image")
const SafeVideoBlock = withRendererErrorBoundary(VideoBlock, "Video")
const SafeAudioBlock = withRendererErrorBoundary(AudioBlock, "Audio")

/**
 * Sanitization schema extended with KaTeX MathML and a small set of safe
 * inline styling attributes. Dangerous protocols (javascript:, etc.) are
 * blocked via the `protocols` whitelist below.
 */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div",
    "span",
    "summary",
    "details",
    "figure",
    "figcaption",
    "sup",
    "sub",
    // KaTeX MathML elements
    "math",
    "annotation",
    "semantics",
    "mrow",
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
    "mspace",
    "msqrt",
    "mroot",
    "mfrac",
    "msub",
    "msup",
    "msubsup",
    "munder",
    "mover",
    "munderover",
    "mtable",
    "mtr",
    "mtd",
    "menclose",
    "maction",
    "mpadded",
    "mphantom",
    "mglyph",
    "mlabeledtr",
    "mmultiscripts",
    "mprescripts",
    "none",
    "maligngroup",
    "malignmark",
  ],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "class", "aria-hidden"],
    div: [...(defaultSchema.attributes?.div ?? []), "className", "class", "style"],
    span: [...(defaultSchema.attributes?.span ?? []), "className", "class", "style"],
    a: [...(defaultSchema.attributes?.a ?? []), "className", "class"],
    img: [...(defaultSchema.attributes?.img ?? []), "className", "class", "loading"],
    th: [...(defaultSchema.attributes?.th ?? []), "className", "class", "rowSpan", "colSpan"],
    td: [...(defaultSchema.attributes?.td ?? []), "className", "class", "rowSpan", "colSpan"],
    // KaTeX-specific attributes
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    mrow: ["displaystyle"],
    mtable: ["columnalign", "columnspacing", "rowspacing"],
    mtd: ["columnalign"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto", "file"],
    src: ["http", "https", "data:image"],
  },
}

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
  [rehypeSanitize, sanitizeSchema],
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
    <div className={cn("markdown-renderer prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
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
            <MathBlock
              content={codeContent}
              scale={mathFontScale}
              alignment={mathDisplayAlignment}
            />
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
              <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono" {...props}>
                {children}
              </code>
            </ProjectFileLink>
          )
        }
        return (
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono" {...props}>
            {children}
          </code>
        )
      }

      if (enableMermaid && language === "mermaid") {
        return <SafeMermaidBlock content={codeContent} />
      }

      if (enableDiff && language === "diff") {
        return <SafeDiffBlock content={codeContent} />
      }

      if (language === "a2ui") {
        return <SafeA2UIBlock content={codeContent} messageId={messageId} />
      }

      const showArtifactButton = codeContent.includes("\n")
      return (
        <div className="relative group/code">
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
    table({ children }) {
      return (
        <div className="overflow-x-auto my-4">
          <table className="min-w-full border-collapse border border-border">{children}</table>
        </div>
      )
    },
    th({ children }) {
      return (
        <th className="border border-border bg-muted px-4 py-2 text-left font-semibold">
          {children}
        </th>
      )
    },
    td({ children }) {
      return <td className="border border-border px-4 py-2">{children}</td>
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
    blockquote({ children }) {
      if (enableAlerts && children) {
        const textContent = extractTextContent(children)
        const alertInfo = parseAlertFromBlockquote(textContent)
        if (alertInfo) {
          return <SafeAlertBlock type={alertInfo.type}>{alertInfo.content}</SafeAlertBlock>
        }
      }
      return (
        <blockquote className="border-l-4 border-primary/30 pl-4 italic text-muted-foreground my-4">
          {children}
        </blockquote>
      )
    },
    ul({ children }) {
      return <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>
    },
    ol({ children }) {
      return <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>
    },
    li({ children }) {
      // GFM task-list items (`- [ ]` / `- [x]`) arrive with a disabled
      // checkbox `<input>` as the first child. Route those to the styled
      // TaskListItem; everything else stays a plain list item.
      const task = parseTaskListItem(children)
      if (task) {
        return <TaskListItem checked={task.checked}>{task.label}</TaskListItem>
      }
      return <li className="leading-relaxed">{children}</li>
    },
    h1({ children, id }) {
      return (
        <h1 id={id} className="scroll-mt-20 text-2xl font-bold mt-6 mb-4">
          {children}
        </h1>
      )
    },
    h2({ children, id }) {
      return (
        <h2 id={id} className="scroll-mt-20 text-xl font-bold mt-5 mb-3">
          {children}
        </h2>
      )
    },
    h3({ children, id }) {
      return (
        <h3 id={id} className="scroll-mt-20 text-lg font-semibold mt-4 mb-2">
          {children}
        </h3>
      )
    },
    h4({ children, id }) {
      return (
        <h4 id={id} className="scroll-mt-20 text-base font-semibold mt-3 mb-2">
          {children}
        </h4>
      )
    },
    h5({ children, id }) {
      return (
        <h5 id={id} className="scroll-mt-20 text-sm font-semibold mt-3 mb-2">
          {children}
        </h5>
      )
    },
    h6({ children, id }) {
      return (
        <h6 id={id} className="scroll-mt-20 text-sm font-medium text-muted-foreground mt-3 mb-2">
          {children}
        </h6>
      )
    },
    p({ children }) {
      return <p className="my-2 leading-relaxed">{children}</p>
    },
    hr() {
      return <hr className="my-6 border-border" />
    },
    img({ src, alt, title }) {
      if (!src || typeof src !== "string") return null
      if (enableVideoEmbed && isVideoUrl(src)) {
        return <SafeVideoBlock src={src} title={title || alt} />
      }
      if (enableAudioEmbed && isAudioUrl(src)) {
        return <SafeAudioBlock src={src} title={title || alt} />
      }
      if (enableEnhancedImages) {
        return <SafeImageBlock src={src} alt={alt || ""} title={title} />
      }

      return (
        // eslint-disable-next-line @next/next/no-img-element -- markdown sources lack the fixed dimensions that next/image requires; ImageBlock above is the optimised path
        <img
          src={src}
          alt={alt || ""}
          title={title}
          className="max-w-full h-auto rounded-lg my-4"
          loading="lazy"
        />
      )
    },
    details({ children }) {
      const childArray = Children.toArray(children)
      let summaryContent: React.ReactNode = "Details"
      const restContent: React.ReactNode[] = []
      childArray.forEach((child) => {
        if (isValidElement(child) && child.type === "summary") {
          const props = child.props as { children?: React.ReactNode }
          summaryContent = props.children
        } else {
          restContent.push(child)
        }
      })
      return <SafeDetailsBlock summary={summaryContent}>{restContent}</SafeDetailsBlock>
    },
    kbd({ children }) {
      return <KbdInline>{children}</KbdInline>
    },
  }
}

/**
 * Detect a GFM task-list item by its leading disabled checkbox `<input>` child.
 * Returns the checked state plus the remaining children (the label, with inline
 * formatting preserved), or null for ordinary list items. Exported for unit
 * testing because remark-gfm / rehype-raw are stubbed in the jest env, so the
 * checkbox child can't be produced through the full markdown pipeline there.
 */
export function parseTaskListItem(
  children: React.ReactNode
): { checked: boolean; label: React.ReactNode[] } | null {
  const childArray = Children.toArray(children)
  const inputIdx = childArray.findIndex(
    (child) =>
      isValidElement(child) &&
      child.type === "input" &&
      (child.props as { type?: string }).type === "checkbox"
  )
  if (inputIdx === -1) return null
  const input = childArray[inputIdx] as React.ReactElement
  const checked = Boolean((input.props as { checked?: boolean }).checked)
  const label = childArray.filter((_, i) => i !== inputIdx)
  return { checked, label }
}

function extractTextContent(children: React.ReactNode): string {
  if (typeof children === "string") return children
  if (typeof children === "number") return String(children)
  if (Array.isArray(children)) {
    return children.map(extractTextContent).join("")
  }
  if (isValidElement(children)) {
    const props = children.props as { children?: React.ReactNode }
    return extractTextContent(props.children)
  }
  return ""
}

function isVideoUrl(url: string): boolean {
  const videoExtensions = /\.(mp4|webm|ogv|mov|avi|mkv)(?:[?#]|$)/i
  if (videoExtensions.test(url)) return true

  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return ["youtube.com", "youtu.be", "vimeo.com", "bilibili.com"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
}

function isAudioUrl(url: string): boolean {
  const audioExtensions = /\.(mp3|wav|ogg|oga|opus|aac|flac|m4a|wma)(?:[?#]|$)/i
  return audioExtensions.test(url)
}
