"use client"

/**
 * Markdown element overrides shared by BOTH chat markdown surfaces:
 *
 *   - `components/chat/markdown-renderer.tsx` (react-markdown) — finalised messages
 *   - `components/chat/streaming-text-part.tsx` (streamdown)   — the live stream
 *
 * Before this module existed the streaming branch overrode only `a`, so an
 * assistant turn containing an image, a table, a GitHub alert, a `<details>`
 * block, a `<kbd>` or a task list rendered with the library defaults while
 * streaming and then visibly re-laid-out the instant the turn finalised and
 * `MessageRenderer` swapped in `MarkdownRenderer`. Sharing the overrides makes
 * the two branches converge.
 *
 * Deliberately NOT shared:
 *   - `code` / `pre` — the streaming branch highlights through
 *     `@streamdown/code` (already theme-aligned via `streamdown-plugins.ts`);
 *     overriding it there would defeat Streamdown's incremental highlighting.
 *     The finalised branch additionally hangs `ArtifactCreateButton` off a
 *     fence, which is meaningless mid-stream.
 *   - `a` — both branches override it, but only the finalised one can offer
 *     `onOpenProjectFile`, so each keeps its own.
 *
 * Type note: streamdown's `Components` (dist/index.d.ts) is structurally the
 * same mapped type as react-markdown's — `JSX.IntrinsicElements` keys taking
 * the element props plus a `node` extra — so one factory satisfies both. The
 * `node?: unknown` widening below is what makes each override assignable to
 * either library's stricter `node?: Element` parameter (parameters are
 * contravariant).
 */

import { Children, isValidElement } from "react"
import { useTranslations } from "next-intl"

import { AlertBlock, parseAlertFromBlockquote } from "@/components/chat/renderers/alert-block"
import { AudioBlock } from "@/components/chat/renderers/audio-block"
import { DetailsBlock } from "@/components/chat/renderers/details-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { KbdInline } from "@/components/chat/renderers/kbd-inline"
import { withRendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { TaskListItem } from "@/components/chat/renderers/task-list"
import { VideoBlock } from "@/components/chat/renderers/video-block"

const SafeAlertBlock = withRendererErrorBoundary(AlertBlock, "Alert")
const SafeDetailsBlock = withRendererErrorBoundary(DetailsBlock, "Details")
const SafeImageBlock = withRendererErrorBoundary(ImageBlock, "Image")
const SafeVideoBlock = withRendererErrorBoundary(VideoBlock, "Video")
const SafeAudioBlock = withRendererErrorBoundary(AudioBlock, "Audio")

/** Element props as both markdown libraries hand them to a component override. */
type MarkdownElementProps<K extends keyof React.JSX.IntrinsicElements> =
  React.JSX.IntrinsicElements[K] & { node?: unknown }

export interface SharedMarkdownComponentOptions {
  /** Route `![](…)` through the rich `ImageBlock`. Defaults to true. */
  enableEnhancedImages?: boolean
  /** Promote `> [!NOTE]`-style blockquotes to `AlertBlock`. Defaults to true. */
  enableAlerts?: boolean
  /** Render video URLs written as images through `VideoBlock`. Defaults to true. */
  enableVideoEmbed?: boolean
  /** Render audio URLs written as images through `AudioBlock`. Defaults to true. */
  enableAudioEmbed?: boolean
}

/**
 * `<details>` needs a translated fallback when the markdown omits `<summary>`.
 * A module-scope component (rather than a hook call inside the factory) keeps
 * the identity stable across `useMemo` recomputes and keeps the factory a
 * plain function.
 */
function MarkdownDetails({ children }: { children: React.ReactNode }) {
  const t = useTranslations("chat.renderers.details")
  const childArray = Children.toArray(children)
  let summaryContent: React.ReactNode = t("defaultSummary")
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
}

/**
 * Build the overrides both markdown surfaces share. Callers spread the result
 * into their own `components` object and add their branch-specific entries.
 */
export function createSharedMarkdownComponents(options: SharedMarkdownComponentOptions = {}) {
  const {
    enableEnhancedImages = true,
    enableAlerts = true,
    enableVideoEmbed = true,
    enableAudioEmbed = true,
  } = options

  return {
    img({ src, alt, title }: MarkdownElementProps<"img">) {
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
    blockquote({ children }: MarkdownElementProps<"blockquote">) {
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
    details({ children }: MarkdownElementProps<"details">) {
      return <MarkdownDetails>{children}</MarkdownDetails>
    },
    kbd({ children }: MarkdownElementProps<"kbd">) {
      return <KbdInline>{children}</KbdInline>
    },
    ul({ children }: MarkdownElementProps<"ul">) {
      return <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>
    },
    ol({ children }: MarkdownElementProps<"ol">) {
      return <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>
    },
    li({ children }: MarkdownElementProps<"li">) {
      // GFM task-list items (`- [ ]` / `- [x]`) arrive with a disabled
      // checkbox `<input>` as the first child. Route those to the styled
      // TaskListItem; everything else stays a plain list item.
      const task = parseTaskListItem(children)
      if (task) {
        return <TaskListItem checked={task.checked}>{task.label}</TaskListItem>
      }
      return <li className="leading-relaxed">{children}</li>
    },
    table({ children }: MarkdownElementProps<"table">) {
      return (
        <div className="overflow-x-auto my-4">
          <table className="min-w-full border-collapse border border-border">{children}</table>
        </div>
      )
    },
    th({ children }: MarkdownElementProps<"th">) {
      return (
        <th className="border border-border bg-muted px-4 py-2 text-left font-semibold">
          {children}
        </th>
      )
    },
    td({ children }: MarkdownElementProps<"td">) {
      return <td className="border border-border px-4 py-2">{children}</td>
    },
    p({ children }: MarkdownElementProps<"p">) {
      return <p className="my-2 leading-relaxed">{children}</p>
    },
    hr() {
      return <hr className="my-6 border-border" />
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

export function extractTextContent(children: React.ReactNode): string {
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

export function isVideoUrl(url: string): boolean {
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

export function isAudioUrl(url: string): boolean {
  const audioExtensions = /\.(mp3|wav|ogg|oga|opus|aac|flac|m4a|wma)(?:[?#]|$)/i
  return audioExtensions.test(url)
}
