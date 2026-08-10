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
 * the two branches converge. Headings joined the shared set for the same
 * reason — they were the last surface left with a stream-to-final size jump.
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

import { Children, isValidElement, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, DownloadIcon, Maximize2Icon, XIcon } from "lucide-react"
import { tableDataToCSV, tableDataToMarkdown, tableDataToTSV, type TableData } from "streamdown"
import { toast } from "sonner"

import { AlertBlock, parseAlertFromBlockquote } from "@/components/chat/renderers/alert-block"
import { AudioBlock } from "@/components/chat/renderers/audio-block"
import { DetailsBlock } from "@/components/chat/renderers/details-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { KbdInline } from "@/components/chat/renderers/kbd-inline"
import { withRendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { TaskListItem } from "@/components/chat/renderers/task-list"
import { VideoBlock } from "@/components/chat/renderers/video-block"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

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
  /** Disable table actions while the source is incomplete. Defaults to false. */
  isStreaming?: boolean
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
 * Rows rendered before a markdown table truncates itself.
 *
 * A tool that returns a query result can emit thousands of rows, and each one
 * is a real `<tr>` with real cells — the benchmark's robustness tier measured
 * multi-second frames on a single 5000-row table. The cap is render-only: the
 * message text is untouched, so search, copy, export and the model's own view
 * of the conversation all still see every row.
 */
export const TABLE_AUTO_RENDER_MAX_ROWS = 200

/**
 * A `<tbody>` that stops at `TABLE_AUTO_RENDER_MAX_ROWS` and offers the rest on
 * request. A module-scope component (rather than a hook call inside the
 * factory) so its identity is stable across `useMemo` recomputes, matching
 * `MarkdownDetails` above.
 */
function MarkdownTableBody({ children }: { children?: React.ReactNode }) {
  const t = useTranslations("chat.renderers.table")
  const [showAll, setShowAll] = useState(false)
  const rows = Children.toArray(children)
  if (showAll || rows.length <= TABLE_AUTO_RENDER_MAX_ROWS) return <tbody>{children}</tbody>

  return (
    <tbody>
      {rows.slice(0, TABLE_AUTO_RENDER_MAX_ROWS)}
      <tr>
        <td
          colSpan={countRowCells(rows[0])}
          className="border border-border bg-muted/40 px-4 py-2 text-xs"
        >
          <span className="text-muted-foreground">
            {t("truncatedNotice", { shown: TABLE_AUTO_RENDER_MAX_ROWS, total: rows.length })}
          </span>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="ml-2 rounded px-2 py-1 font-medium text-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
          >
            {t("showAllRows")}
          </button>
        </td>
      </tr>
    </tbody>
  )
}

interface MarkdownAstNode {
  type?: string
  tagName?: string
  value?: string
  children?: MarkdownAstNode[]
}

function markdownAstText(node: MarkdownAstNode): string {
  if (node.type === "text") return node.value ?? ""
  if (node.tagName === "br") return "\n"
  return node.children?.map(markdownAstText).join("") ?? ""
}

function tableSectionRows(node: MarkdownAstNode | undefined, tagName: string): MarkdownAstNode[] {
  return (
    node?.children
      ?.filter((child) => child.tagName === tagName)
      .flatMap((section) => section.children?.filter((child) => child.tagName === "tr") ?? []) ?? []
  )
}

function tableRowCells(row: MarkdownAstNode | undefined): string[] {
  return (
    row?.children
      ?.filter((child) => child.tagName === "th" || child.tagName === "td")
      .map((cell) => markdownAstText(cell).trim()) ?? []
  )
}

/** Complete source data from the HAST node, independent of the visual row cap. */
export function extractMarkdownTableData(node: unknown): TableData {
  if (!node || typeof node !== "object") return { headers: [], rows: [] }
  const table = node as MarkdownAstNode
  const headerRows = tableSectionRows(table, "thead")
  const bodyRows = [...tableSectionRows(table, "tbody"), ...tableSectionRows(table, "tfoot")]
  const headers = tableRowCells(headerRows[0])
  const rows = bodyRows.map(tableRowCells)
  return { headers, rows }
}

type TableAlignment = "left" | "center" | "right"

function safeTableAlignment(...values: unknown[]): TableAlignment | undefined {
  return values.find(
    (value): value is TableAlignment => value === "left" || value === "center" || value === "right"
  )
}

type TableCopyFormat = "markdown" | "csv" | "tsv"
type TableDownloadFormat = "markdown" | "csv"

function serializeTable(data: TableData, format: TableCopyFormat): string {
  if (format === "csv") return tableDataToCSV(data)
  if (format === "tsv") return tableDataToTSV(data)
  return tableDataToMarkdown(data)
}

function downloadTable(data: TableData, format: TableDownloadFormat): void {
  const content = format === "csv" ? tableDataToCSV(data) : tableDataToMarkdown(data)
  const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8"
  const extension = format === "csv" ? "csv" : "md"
  const prefix = format === "csv" ? "\uFEFF" : ""
  const url = URL.createObjectURL(new Blob([prefix, content], { type: mimeType }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `table.${extension}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function MarkdownTable({
  children,
  node,
  isStreaming,
}: {
  children?: React.ReactNode
  node?: unknown
  isStreaming: boolean
}) {
  const t = useTranslations("chat.renderers.table")
  const [fullscreen, setFullscreen] = useState(false)
  const data = useMemo(() => extractMarkdownTableData(node), [node])

  const copy = async (format: TableCopyFormat) => {
    try {
      await navigator.clipboard.writeText(serializeTable(data, format))
    } catch {
      toast.error(t("actionFailed"))
    }
  }

  const download = (format: TableDownloadFormat) => {
    try {
      downloadTable(data, format)
    } catch {
      toast.error(t("actionFailed"))
    }
  }

  const controls = (
    <div
      className="not-typeset flex items-center justify-end gap-1"
      data-testid="markdown-table-actions"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={isStreaming}
            aria-label={t("copy")}
          >
            <CopyIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void copy("markdown")}>
            {t("copyMarkdown")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copy("csv")}>{t("copyCsv")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copy("tsv")}>{t("copyTsv")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={isStreaming}
            aria-label={t("download")}
          >
            <DownloadIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => download("csv")}>{t("downloadCsv")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => download("markdown")}>
            {t("downloadMarkdown")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={isStreaming}
        aria-label={t("fullscreen")}
        onClick={() => setFullscreen(true)}
      >
        <Maximize2Icon aria-hidden />
      </Button>
    </div>
  )

  return (
    <>
      <div className="typeset-scroll flex flex-col gap-1" data-streamdown="table-wrapper">
        {controls}
        <table className="min-w-full border-collapse border border-border" data-streamdown="table">
          {children}
        </table>
      </div>
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{t("fullscreen")}</DialogTitle>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("closeFullscreen")}
              >
                <XIcon aria-hidden />
              </Button>
            </DialogClose>
          </div>
          <div className="typeset min-h-0 flex-1 overflow-auto">
            <div className="typeset-scroll">
              <table className="min-w-full border-collapse border border-border">{children}</table>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Cell count of a rendered `<tr>`, so the notice spans the whole table. */
export function countRowCells(row: React.ReactNode): number {
  if (!isValidElement(row)) return 1
  const cells = Children.toArray((row.props as { children?: React.ReactNode }).children).filter(
    (child) => isValidElement(child)
  )
  return Math.max(1, cells.length)
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
    isStreaming = false,
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
        <img src={src} alt={alt || ""} title={title} loading="lazy" />
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
      // The accent rule and the muted italic are Cognia's, so they stay as
      // utilities (which outrank typeset's `:where()` rules); the indent and
      // the vertical rhythm are generic, so typeset owns them.
      return (
        <blockquote className="border-l-4 border-primary/30 italic text-muted-foreground">
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
    // Marker glyphs, indent and item spacing all come from typeset, which also
    // varies the marker by nesting depth (disc → circle → square) — something
    // the flat `list-disc` never did.
    ul({ children }: MarkdownElementProps<"ul">) {
      return <ul>{children}</ul>
    },
    ol({ children, start }: MarkdownElementProps<"ol">) {
      return <ol start={start}>{children}</ol>
    },
    li({ children }: MarkdownElementProps<"li">) {
      // GFM task-list items (`- [ ]` / `- [x]`) arrive with a disabled
      // checkbox `<input>` as the first child. Route those to the styled
      // TaskListItem; everything else stays a plain list item.
      const task = parseTaskListItem(children)
      if (task) {
        return <TaskListItem checked={task.checked}>{task.label}</TaskListItem>
      }
      return <li>{children}</li>
    },
    // `typeset-scroll` is typeset's own wide-block wrapper: it owns the flow
    // margin, zeroes the child's, and widens the table to `max-content` so a
    // wide table scrolls instead of compressing. The grid rules and the header
    // fill stay Cognia's — including the cell padding, which has to outrank
    // typeset's `th:first-child { padding-inline-start: 0 }` or the first
    // column's text would sit flush against the border.
    table({ children, node }: MarkdownElementProps<"table">) {
      return (
        <MarkdownTable node={node} isStreaming={isStreaming}>
          {children}
        </MarkdownTable>
      )
    },
    tbody({ children }: MarkdownElementProps<"tbody">) {
      return <MarkdownTableBody>{children}</MarkdownTableBody>
    },
    th({ children, align, colSpan, rowSpan, style }: MarkdownElementProps<"th">) {
      const textAlign = safeTableAlignment(style?.textAlign, align)
      return (
        <th
          align={textAlign}
          colSpan={colSpan}
          rowSpan={rowSpan}
          style={textAlign ? { textAlign } : undefined}
          className="border border-border bg-muted px-4 py-2 text-left font-semibold"
        >
          {children}
        </th>
      )
    },
    td({ children, align, colSpan, rowSpan, style }: MarkdownElementProps<"td">) {
      const textAlign = safeTableAlignment(style?.textAlign, align)
      return (
        <td
          align={textAlign}
          colSpan={colSpan}
          rowSpan={rowSpan}
          style={textAlign ? { textAlign } : undefined}
          className="border border-border px-4 py-2"
        >
          {children}
        </td>
      )
    },
    p({ children }: MarkdownElementProps<"p">) {
      return <p>{children}</p>
    },
    hr() {
      return <hr />
    },
    // Size, weight and rhythm come from typeset, whose scale is `em`-relative
    // and so tracks the container — the old absolute `text-2xl`/`text-xl` set
    // did not, and rendered the same 24px heading in a 14px chat turn and a
    // 16px README. Two things typeset cannot supply stay as utilities:
    //
    //   - `scroll-mt-20` clears the sticky chat header when a permalink jumps
    //     to a heading. typeset sets `scroll-margin-block-start` to one flow
    //     step (~14px), which lands the target under the header.
    //   - h6's uppercase + letter-spacing is a label treatment this product
    //     does not use, so it is neutralised. The 0.8125em size stays, or h6
    //     would end up larger than h5.
    //
    // `id` is populated by `rehypeMarkdownHeadingIds` on the finalised branch
    // only; mid-stream it is simply absent, which costs nothing.
    h1({ children, id }: MarkdownElementProps<"h1">) {
      return (
        <h1 id={id} className="scroll-mt-20">
          {children}
        </h1>
      )
    },
    h2({ children, id }: MarkdownElementProps<"h2">) {
      return (
        <h2 id={id} className="scroll-mt-20">
          {children}
        </h2>
      )
    },
    h3({ children, id }: MarkdownElementProps<"h3">) {
      return (
        <h3 id={id} className="scroll-mt-20">
          {children}
        </h3>
      )
    },
    h4({ children, id }: MarkdownElementProps<"h4">) {
      return (
        <h4 id={id} className="scroll-mt-20">
          {children}
        </h4>
      )
    },
    h5({ children, id }: MarkdownElementProps<"h5">) {
      return (
        <h5 id={id} className="scroll-mt-20">
          {children}
        </h5>
      )
    },
    h6({ children, id }: MarkdownElementProps<"h6">) {
      return (
        <h6 id={id} className="scroll-mt-20 normal-case tracking-normal">
          {children}
        </h6>
      )
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
