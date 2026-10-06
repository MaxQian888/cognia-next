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

import { Children, cloneElement, isValidElement, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, DownloadIcon, Maximize2Icon, TableIcon } from "lucide-react"
import { tableDataToCSV, tableDataToMarkdown, tableDataToTSV, type TableData } from "streamdown"
import { toast } from "sonner"
import { downloadBlob, type DownloadOutcome } from "@/lib/files/download"
import {
  parseProjectFileReference,
  type ProjectFileReference,
} from "@/lib/files/project-file-reference"
import { cn } from "@/lib/utils"

import { ProjectFileLink } from "@/components/chat/project-file-link"
import { AlertBlock, extractAlertFromChildren } from "@/components/chat/renderers/alert-block"
import { AudioBlock } from "@/components/chat/renderers/audio-block"
import { DetailsBlock } from "@/components/chat/renderers/details-block"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { KbdInline } from "@/components/chat/renderers/kbd-inline"
import { withRendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { TaskListItem } from "@/components/chat/renderers/task-list"
import { VideoBlock } from "@/components/chat/renderers/video-block"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import {
  RICH_BLOCK_FULLSCREEN_ACTION_CLASS,
  RichBlockFullscreen,
} from "@/components/chat/renderers/rich-block/rich-block-fullscreen"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
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
          className="bg-muted/40 px-(--rich-cell-px) py-(--rich-cell-py) text-xs"
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

/**
 * Download goes through the shared `downloadBlob`, which hands the file to the
 * native share sheet inside the mobile WebView (where an `<a download>` click
 * silently produced nothing) and clicks an anchor everywhere else.
 */
function downloadTable(data: TableData, format: TableDownloadFormat): Promise<DownloadOutcome> {
  const content = format === "csv" ? tableDataToCSV(data) : tableDataToMarkdown(data)
  const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8"
  const extension = format === "csv" ? "csv" : "md"
  const prefix = format === "csv" ? "\uFEFF" : ""
  return downloadBlob(new Blob([prefix, content], { type: mimeType }), `table.${extension}`)
}

/** Matches a plain number cell: sign, grouping, decimals, %, currency, units. */
const NUMERIC_CELL =
  /^[+\-−]?[$€£¥₹]?\s?(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.\d+)?\s?(?:%|[kKmMbB]|ms|s|x|×)?$/

/**
 * Columns whose every non-empty body cell is a number. They right-align (and
 * read in tabular figures) unless the author set an alignment, which is how a
 * reader compares magnitudes down a column.
 */
export function numericColumns(data: TableData): Set<number> {
  const numeric = new Set<number>()
  const width = Math.max(data.headers.length, ...data.rows.map((row) => row.length))
  for (let column = 0; column < width; column++) {
    let sawNumber = false
    let allNumeric = true
    for (const row of data.rows) {
      const cell = (row[column] ?? "").trim()
      if (!cell || cell === "-" || cell === "—") continue
      if (NUMERIC_CELL.test(cell)) sawNumber = true
      else {
        allNumeric = false
        break
      }
    }
    if (sawNumber && allNumeric) numeric.add(column)
  }
  return numeric
}

/**
 * Right-align the numeric columns by cloning `align` onto their cells. The cell
 * overrides cannot do it themselves: react-markdown hands a cell no column
 * index. Cells the author aligned keep their alignment.
 */
function alignNumericColumns(children: React.ReactNode, numeric: Set<number>): React.ReactNode {
  if (numeric.size === 0) return children
  const alignRow = (row: React.ReactNode) => {
    if (!isValidElement(row)) return row
    let column = 0
    const cells = Children.map((row.props as { children?: React.ReactNode }).children, (cell) => {
      if (!isValidElement(cell)) return cell
      const index = column++
      const props = cell.props as { align?: string; style?: React.CSSProperties }
      if (!numeric.has(index) || props.align || props.style?.textAlign) return cell
      return cloneElement(cell as React.ReactElement<{ align?: string }>, { align: "right" })
    })
    return cloneElement(row, undefined, cells)
  }
  return Children.map(children, (section) => {
    if (!isValidElement(section)) return section
    const rows = Children.map((section.props as { children?: React.ReactNode }).children, alignRow)
    return cloneElement(section, undefined, rows)
  })
}

const TABLE_CLASS =
  "w-max min-w-full border-separate border-spacing-0 text-left tabular-nums [&_tbody_tr:last-child>td]:border-b-0 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/40"

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
  const aligned = useMemo(
    () => alignNumericColumns(children, numericColumns(data)),
    [children, data]
  )
  const dimensions = t("dimensions", {
    rows: data.rows.length,
    columns: Math.max(data.headers.length, ...data.rows.map((row) => row.length), 0),
  })

  const copy = async (format: TableCopyFormat) => {
    try {
      await navigator.clipboard.writeText(serializeTable(data, format))
    } catch {
      toast.error(t("actionFailed"))
    }
  }

  const download = async (format: TableDownloadFormat) => {
    try {
      const outcome = await downloadTable(data, format)
      if (outcome.kind === "error") toast.error(t("actionFailed"))
    } catch {
      toast.error(t("actionFailed"))
    }
  }

  const menus = (fullscreenSize: boolean) => {
    // An element factory, not a component: `DropdownMenuTrigger asChild` needs
    // the button's own ref, which both of these forward.
    const trigger = (label: string, icon: React.ReactNode) =>
      fullscreenSize ? (
        <TooltipIconButton
          variant="ghost"
          size="icon"
          className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
          disabled={isStreaming}
          aria-label={label}
          tooltip={label}
        >
          {icon}
        </TooltipIconButton>
      ) : (
        <RichBlockAction label={label} disabled={isStreaming}>
          {icon}
        </RichBlockAction>
      )
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {trigger(t("copy"), <CopyIcon aria-hidden />)}
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
            {trigger(t("download"), <DownloadIcon aria-hidden />)}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void download("csv")}>
              {t("downloadCsv")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void download("markdown")}>
              {t("downloadMarkdown")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    )
  }

  // The toolbar floats over the table's corner instead of taking a row of its
  // own (ADR-0218): the header row already reads as the block's header.
  return (
    <>
      <RichBlockFrame
        kind="table"
        header="overlay"
        data-streamdown="table-wrapper"
        aria-label={dimensions}
        role="group"
        actions={
          <>
            {menus(false)}
            <RichBlockAction
              label={t("fullscreen")}
              disabled={isStreaming}
              onClick={() => setFullscreen(true)}
            >
              <Maximize2Icon aria-hidden />
            </RichBlockAction>
          </>
        }
        bodyClassName="overflow-x-auto overscroll-x-contain"
      >
        <table className={TABLE_CLASS} data-streamdown="table">
          {aligned}
        </table>
      </RichBlockFrame>
      <RichBlockFullscreen
        open={fullscreen}
        onOpenChange={setFullscreen}
        testId="table-fullscreen"
        icon={<TableIcon />}
        title={t("title")}
        subtitle={<span className="tabular-nums">{dimensions}</span>}
        actions={menus(true)}
      >
        {fullscreen ? (
          <table className={cn(TABLE_CLASS, "[&_thead_th]:sticky [&_thead_th]:top-0")}>
            {aligned}
          </table>
        ) : null}
      </RichBlockFullscreen>
    </>
  )
}

/**
 * Inline code for both markdown branches.
 *
 * Streamdown's default inline code carried an absolute `text-sm`, while the
 * finalised branch let typeset size it at 0.85em, so every inline span shrank
 * the moment a turn finalised. It also skipped the project-file detection, so
 * a `src/app.ts` span only became clickable after the stream ended. One
 * component for both removes both jumps. No size class: typeset owns the
 * 0.85em so it tracks whichever preset the container carries.
 */
export function MarkdownInlineCode({
  children,
  projectRoot,
  onOpenProjectFile,
  className,
}: {
  children?: React.ReactNode
  projectRoot?: string | null
  onOpenProjectFile?: (target: ProjectFileReference) => void
  className?: string
}) {
  const code = (
    <code
      className={cn("rounded bg-muted px-1.5 py-0.5 font-mono", className)}
      data-markdown-inline-code
    >
      {children}
    </code>
  )
  const text = typeof children === "string" ? children : Children.toArray(children).join("")
  const target = text ? parseProjectFileReference(text, projectRoot) : null
  if (!target) return code
  return (
    <ProjectFileLink target={target} onOpenFile={onOpenProjectFile} projectRoot={projectRoot}>
      {code}
    </ProjectFileLink>
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
        const alertInfo = extractAlertFromChildren(children)
        if (alertInfo) {
          return <SafeAlertBlock type={alertInfo.type}>{alertInfo.children}</SafeAlertBlock>
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
    // Tables draw in the shared `RichBlockFrame` (ADR-0218): rounded, row
    // separators only, a tinted header, row hover and a hover toolbar over the
    // corner. The frame is `not-typeset`, so the cell padding (from the
    // block-density variables) is the only padding, first column included.
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
          className="border-b bg-muted/60 px-(--rich-cell-px) py-(--rich-cell-py) text-left text-xs font-semibold whitespace-nowrap text-foreground/90"
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
          className="border-b border-border/60 px-(--rich-cell-px) py-(--rich-cell-py) align-top"
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
