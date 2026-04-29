"use client"

/**
 * MarkdownRenderer — full-featured markdown rendering for completed messages.
 *
 * Backed by react-markdown + remark-gfm + remark-math + rehype-raw + rehype-sanitize,
 * with custom block renderers from `components/chat/renderers/*` for code, math,
 * mermaid, diff, images, video/audio, alerts, details, and kbd.
 *
 * Streaming text uses streamdown (see ai-elements/message MessageResponse).
 */

import { memo, useMemo, isValidElement, Children } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import { cn } from "@/lib/utils"
import { MathBlock } from "@/components/chat/renderers/math-block"
import { MathInline } from "@/components/chat/renderers/math-inline"
import { MermaidBlock } from "@/components/chat/renderers/mermaid-block"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { DiffBlock } from "@/components/chat/renderers/diff-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { VideoBlock } from "@/components/chat/renderers/video-block"
import { AudioBlock } from "@/components/chat/renderers/audio-block"
import { AlertBlock, parseAlertFromBlockquote } from "@/components/chat/renderers/alert-block"
import { DetailsBlock } from "@/components/chat/renderers/details-block"
import { KbdInline } from "@/components/chat/renderers/kbd-inline"

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
    href: ["http", "https", "mailto"],
    src: ["http", "https", "data:image"],
  },
}

/**
 * Convert `\[...\]` → `$$...$$` and `\(...\)` → `$...$` so remark-math accepts
 * the wider variety of LaTeX delimiters Claude tends to emit.
 */
function preprocessLatex(content: string): string {
  let processed = content.replace(/\\\[([\s\S]*?)\\\]/g, (_match, eq) => `$$${eq}$$`)
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_match, eq) => `$${eq}$`)
  return processed
}

interface MarkdownRendererProps {
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
}: MarkdownRendererProps) {
  const remarkPlugins = useMemo(() => {
    const plugins: NonNullable<Parameters<typeof ReactMarkdown>[0]["remarkPlugins"]> = [remarkGfm]
    if (enableMath) {
      plugins.push(remarkMath)
    }
    return plugins
  }, [enableMath])

  const rehypePlugins = useMemo(() => {
    const plugins: NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]> = [rehypeRaw]
    plugins.push([rehypeSanitize, sanitizeSchema])
    return plugins
  }, [])

  const processedContent = useMemo(() => {
    if (enableMath) {
      return preprocessLatex(content)
    }
    return content
  }, [content, enableMath])

  return (
    <div className={cn("markdown-renderer prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          code({ className: codeClassName, children, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName || "")
            const language = match ? match[1] : undefined
            const codeContent = String(children).replace(/\n$/, "")
            const isInline = !match && !codeContent.includes("\n")

            // remark-math emits code elements with `language-math` and an
            // additional `math-display` / `math-inline` class. We catch these
            // before generic code-block handling.
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
              return (
                <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono" {...props}>
                  {children}
                </code>
              )
            }

            if (enableMermaid && language === "mermaid") {
              return <MermaidBlock content={codeContent} />
            }

            if (enableDiff && language === "diff") {
              return <DiffBlock content={codeContent} />
            }

            return (
              <CodeBlock code={codeContent} language={language} showLineNumbers={showLineNumbers} />
            )
          },
          pre({ children }) {
            return <>{children}</>
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-4">
                <table className="min-w-full border-collapse border border-border">
                  {children}
                </table>
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
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {children}
              </a>
            )
          },
          blockquote({ children }) {
            if (enableAlerts && children) {
              const textContent = extractTextContent(children)
              const alertInfo = parseAlertFromBlockquote(textContent)
              if (alertInfo) {
                return <AlertBlock type={alertInfo.type}>{alertInfo.content}</AlertBlock>
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
            return <li className="leading-relaxed">{children}</li>
          },
          h1({ children }) {
            return <h1 className="text-2xl font-bold mt-6 mb-4">{children}</h1>
          },
          h2({ children }) {
            return <h2 className="text-xl font-bold mt-5 mb-3">{children}</h2>
          },
          h3({ children }) {
            return <h3 className="text-lg font-semibold mt-4 mb-2">{children}</h3>
          },
          h4({ children }) {
            return <h4 className="text-base font-semibold mt-3 mb-2">{children}</h4>
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
              return <VideoBlock src={src} title={title || alt} />
            }

            if (enableAudioEmbed && isAudioUrl(src)) {
              return <AudioBlock src={src} title={title || alt} />
            }

            if (enableEnhancedImages) {
              return <ImageBlock src={src} alt={alt || ""} title={title} />
            }

            return (
              // eslint-disable-next-line @next/next/no-img-element
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

            return <DetailsBlock summary={summaryContent}>{restContent}</DetailsBlock>
          },
          kbd({ children }) {
            return <KbdInline>{children}</KbdInline>
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  )
})

MarkdownRenderer.displayName = "MarkdownRenderer"

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
  const videoExtensions = /\.(mp4|webm|ogg|mov|avi|mkv)$/i
  const videoPlatforms = /(youtube\.com|youtu\.be|vimeo\.com|bilibili\.com)/i
  return videoExtensions.test(url) || videoPlatforms.test(url)
}

function isAudioUrl(url: string): boolean {
  const audioExtensions = /\.(mp3|wav|ogg|aac|flac|m4a|wma)$/i
  return audioExtensions.test(url)
}
