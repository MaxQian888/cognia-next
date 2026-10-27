"use client"

/**
 * Renders an InboundA2UIBlock (produced by adapter inbound-to-a2ui
 * mappers) in the Inbox detail pane and the chat transcript.
 *
 * Designed to be a structural mirror of A2UI's component vocabulary so
 * the same visual primitives that render outbound assistant surfaces
 * also show inbound platform-native UI.
 *
 * Interaction is deliberately read-only. Plain links and URL-only buttons
 * open in the browser like any other link; buttons that carry a platform
 * callback (`actionId`) are inert here: pressing them would act on the
 * sender's behalf in another app, which needs its own ownership and
 * authorization contract. They render disabled with a tooltip saying so.
 *
 * Media references only the platform can resolve (`lark-img:`,
 * `telegram-file:`, `mxc://`) render as a labelled placeholder instead of
 * a broken image. A block is shape-checked before it reaches this
 * component, and a render failure is contained to this block.
 *
 * Unrecognised structure from the original payload is rendered behind
 * a disclosure as raw JSON so operators can verify the mapper
 * didn't drop content.
 */

import { useTranslations } from "next-intl"
import { useId, useMemo, useRef, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, ImageOffIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ExternalLink } from "@/components/shared/external-link"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Image } from "@/components/ai-elements/image"
import { ImageLightbox, type ImageLightboxItem } from "@/components/chat/renderers/image-lightbox"
import { RendererErrorBoundary } from "@/components/chat/renderers/renderer-error-boundary"
import { Badge } from "@/components/ui/badge"
import type {
  InboundA2UIBlock,
  InboundA2UINode,
} from "@/lib/connectors/adapters/_shared/inbound-a2ui-types"
import {
  isDisplayableInboundMediaUrl,
  isNavigableInboundUrl,
} from "@/lib/connectors/adapters/_shared/inbound-a2ui-normalize"

const SOURCE_LABEL: Record<InboundA2UIBlock["source"], string> = {
  slack: "Slack Block Kit",
  lark: "Lark Card",
  discord: "Discord Embed",
  telegram: "Telegram Inline",
  onebot: "OneBot",
  wecom: "WeCom",
  "wechat-personal": "WeChat",
  "wechat-oa": "WeChat OA",
  matrix: "Matrix",
  "qq-official": "QQ",
  dingtalk: "DingTalk",
}

/** The platform itself, for "use it in …" hints (brand names, not copy). */
const PLATFORM_NAME: Record<InboundA2UIBlock["source"], string> = {
  slack: "Slack",
  lark: "Lark",
  discord: "Discord",
  telegram: "Telegram",
  onebot: "QQ",
  wecom: "WeCom",
  "wechat-personal": "WeChat",
  "wechat-oa": "WeChat",
  matrix: "Matrix",
  "qq-official": "QQ",
  dingtalk: "DingTalk",
}

export interface InboundA2UIRendererProps {
  block: InboundA2UIBlock
  className?: string
}

export function InboundA2UIRenderer({ block, className }: InboundA2UIRendererProps) {
  return (
    <RendererErrorBoundary rendererName="inbound-a2ui" className={className} resetKey={block}>
      <InboundA2UIBlockView block={block} className={className} />
    </RendererErrorBoundary>
  )
}

function InboundA2UIBlockView({ block, className }: InboundA2UIRendererProps) {
  const tImage = useTranslations("chat.renderers.image")
  const images = useMemo(
    () => collectImages(block.body, tImage("defaultFilename")),
    [block.body, tImage]
  )
  const [preview, setPreview] = useState({
    body: block.body,
    source: block.source,
    src: null as string | null,
  })
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const sameRevision = preview.source === block.source && samePreviewBody(preview.body, block.body)
  if (preview.body !== block.body || preview.source !== block.source) {
    // Clear before committing a changed revision, rather than only hiding the
    // modal. Identical IndexedDB/remote rehydration preserves the selection.
    setPreview({ body: block.body, source: block.source, src: sameRevision ? preview.src : null })
  }
  const activeIndex = sameRevision ? images.findIndex((image) => image.src === preview.src) : -1
  const onImageOpen: OpenImage = (src, trigger) => {
    returnFocusRef.current = trigger
    setPreview({ body: block.body, source: block.source, src })
  }
  // Mappers usually repeat the card title as the first heading; show it once.
  const first = block.body[0]
  const titleInBody = first?.kind === "heading" && first.text === block.title
  return (
    <div
      data-testid="inbound-a2ui"
      data-source={block.source}
      className={cn(
        "min-w-0 max-w-full rounded-md border bg-muted/20 px-3 py-2 text-sm space-y-2 [overflow-wrap:anywhere]",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {SOURCE_LABEL[block.source] ?? block.source}
        </Badge>
        {block.title && !titleInBody && (
          <span className="min-w-0 text-xs font-medium">{block.title}</span>
        )}
      </div>
      <div className="space-y-1.5">
        {block.body.map((node, idx) => (
          <NodeRenderer key={idx} node={node} source={block.source} onImageOpen={onImageOpen} />
        ))}
      </div>
      {block.raw !== undefined && <RawJsonDetails payload={block.raw} />}
      <ImageLightbox
        items={images}
        open={activeIndex >= 0}
        activeIndex={activeIndex}
        returnFocusRef={returnFocusRef}
        onActiveIndexChange={(index) => {
          if (images[index])
            setPreview({ body: block.body, source: block.source, src: images[index].src })
        }}
        onOpenChange={(open) => {
          if (!open) setPreview({ body: block.body, source: block.source, src: null })
        }}
      />
    </div>
  )
}

type Source = InboundA2UIBlock["source"]
type OpenImage = (src: string, trigger: HTMLButtonElement) => void

/** Compare the bounded, normalized presentation without serializing media bytes. */
function samePreviewBody(left: InboundA2UINode[], right: InboundA2UINode[]): boolean {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((node, index) => {
    const other = right[index]
    if (node === other) return true
    if (!node || !other || node.kind !== other.kind) return false
    const a = node as unknown as Record<string, unknown>
    const b = other as unknown as Record<string, unknown>
    // Raw inspection payloads don't select the image or change rendered prose.
    const keys = Object.keys(a).filter((key) => key !== "payload")
    return (
      keys.length === Object.keys(b).filter((key) => key !== "payload").length &&
      keys.every((key) =>
        key === "children"
          ? samePreviewBody(a.children as InboundA2UINode[], b.children as InboundA2UINode[])
          : Object.is(a[key], b[key])
      )
    )
  })
}

function collectImages(nodes: InboundA2UINode[], defaultFilename: string): ImageLightboxItem[] {
  const images: ImageLightboxItem[] = []
  const seen = new Set<string>()
  const visit = (children: InboundA2UINode[]) => {
    for (const node of children) {
      if (node.kind === "image") {
        const src = node.displayUrl ?? node.url
        if (!isDisplayableInboundMediaUrl(src) || seen.has(src)) continue
        seen.add(src)
        // Supply a bounded download name: the shared viewer's URL fallback
        // would otherwise use the entire base64 payload as a filename.
        const name =
          node.alt
            ?.trim()
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
            .slice(0, 96) || defaultFilename
        const extension =
          /^data:image\/(png|jpeg|gif|webp|avif);/i.exec(src)?.[1] ??
          /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.exec(src)?.[1]
        const stem = name.replace(/\.(?:png|jpe?g|gif|webp|avif)$/i, "") || defaultFilename
        images.push({
          id: `inbound-${images.length}`,
          src,
          alt: node.alt,
          filename: extension ? `${stem}.${extension.toLowerCase()}` : name,
        })
      } else if ("children" in node && Array.isArray(node.children)) {
        visit(node.children)
      }
    }
  }
  visit(nodes)
  return images
}

function NodeRenderer({
  node,
  source,
  onImageOpen,
}: {
  node: InboundA2UINode
  source: Source
  onImageOpen: OpenImage
}) {
  const t = useTranslations("inbox.inboundA2UI")
  switch (node.kind) {
    case "text": {
      const emphasisClass = cn(
        node.emphasis === "muted" && "text-xs text-muted-foreground",
        node.emphasis === "bold" && "font-medium",
        node.emphasis === "italic" && "italic",
        node.emphasis === "code" && "font-mono text-xs"
      )
      if (node.format === "markdown") {
        return (
          <MarkdownRenderer
            content={node.text}
            untrusted
            className={cn(
              "text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
              emphasisClass
            )}
          />
        )
      }
      return (
        <p className={cn("whitespace-pre-wrap text-sm leading-relaxed", emphasisClass)}>
          {node.text}
        </p>
      )
    }
    case "heading": {
      const Tag = `h${node.level + 2}` as unknown as "h3" | "h4" | "h5"
      return (
        <Tag
          className={cn(
            "font-semibold",
            node.level === 1 && "text-base",
            node.level === 2 && "text-sm",
            node.level === 3 && "text-xs uppercase tracking-wide"
          )}
        >
          {node.text}
        </Tag>
      )
    }
    case "image":
      return (
        <InboundImage
          key={node.displayUrl ?? node.url}
          node={node}
          source={source}
          onImageOpen={onImageOpen}
        />
      )
    case "link":
      if (!isNavigableInboundUrl(node.href)) {
        return <span className="text-xs text-muted-foreground">{node.label}</span>
      }
      return (
        <ExternalLink
          href={node.href}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="min-w-0">{node.label}</span>
          <ExternalLinkIcon className="h-3 w-3 shrink-0" aria-hidden />
        </ExternalLink>
      )
    case "button":
      return <ButtonNode node={node} source={source} />
    case "divider":
      return <hr className="border-border/60" />
    case "row":
      return (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} onImageOpen={onImageOpen} />
          ))}
        </div>
      )
    case "column":
      return (
        <div className="flex min-w-0 max-w-full flex-col gap-1">
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} onImageOpen={onImageOpen} />
          ))}
        </div>
      )
    case "list": {
      const Tag = node.ordered ? "ol" : "ul"
      return (
        <Tag
          className={cn("ml-4 space-y-0.5 text-sm", node.ordered ? "list-decimal" : "list-disc")}
        >
          {node.children.map((child, idx) => (
            <li key={idx}>
              <NodeRenderer node={child} source={source} onImageOpen={onImageOpen} />
            </li>
          ))}
        </Tag>
      )
    }
    case "card":
      return (
        <div className="min-w-0 max-w-full rounded-md border bg-background px-3 py-2 space-y-1">
          {node.title && <p className="text-sm font-semibold">{node.title}</p>}
          {node.subtitle && <p className="text-xs text-muted-foreground">{node.subtitle}</p>}
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} onImageOpen={onImageOpen} />
          ))}
        </div>
      )
    case "alert":
      return (
        <div
          className={cn(
            "min-w-0 max-w-full rounded-md border px-3 py-2 text-sm",
            node.tone === "info" && "border-sky-300 bg-sky-50 dark:bg-sky-950/30",
            node.tone === "warning" && "border-amber-300 bg-amber-50 dark:bg-amber-950/30",
            node.tone === "success" && "border-green-300 bg-green-50 dark:bg-green-950/30",
            node.tone === "error" && "border-destructive/40 bg-destructive/10"
          )}
        >
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} onImageOpen={onImageOpen} />
          ))}
        </div>
      )
    case "mention":
      return (
        <Badge variant="secondary" className="max-w-full whitespace-normal text-[11px]">
          @{node.resolved ?? node.handle}
        </Badge>
      )
    case "reply_context":
      return (
        <p className="rounded-l-md border-l-2 border-muted-foreground/30 pl-2 text-xs italic text-muted-foreground">
          ↩ {node.preview ?? t("replyTo", { id: node.replyToMessageId })}
        </p>
      )
    case "raw_json":
      return <RawJsonDetails payload={node.payload} label={node.label} />
  }
}

const BUTTON_CLASS =
  "inline-flex min-h-7 min-w-0 max-w-full items-center whitespace-normal rounded-md border px-2 py-1 text-left text-xs"

function InboundImage({
  node,
  source,
  onImageOpen,
}: {
  node: Extract<InboundA2UINode, { kind: "image" }>
  source: Source
  onImageOpen: OpenImage
}) {
  const t = useTranslations("chat.renderers.image")
  const [failed, setFailed] = useState(false)
  const url = node.displayUrl ?? node.url
  if (failed || !isDisplayableInboundMediaUrl(url))
    return <UnavailableImage alt={node.alt} source={source} />
  return (
    <button
      type="button"
      aria-label={t("previewAria", { name: node.alt?.trim() || t("defaultTitle") })}
      aria-haspopup="dialog"
      onClick={(event) => onImageOpen(url, event.currentTarget)}
      className="block min-w-0 max-w-full cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Image
        src={url}
        alt={node.alt ?? ""}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-auto max-h-64 w-auto max-w-full rounded border object-contain"
      />
    </button>
  )
}

function ButtonNode({
  node,
  source,
}: {
  node: Extract<InboundA2UINode, { kind: "button" }>
  source: Source
}) {
  const t = useTranslations("inbox.inboundA2UI")
  const styleClass = cn(
    node.style === "primary" && "border-primary/40 bg-primary/10",
    node.style === "danger" && "border-destructive/40 bg-destructive/10"
  )
  const label = node.label || t("untitledAction")
  // A button that only opens a URL is a link with a frame: following it does
  // nothing on the sender's behalf.
  if (node.url && !Object.hasOwn(node, "actionId") && isNavigableInboundUrl(node.url)) {
    return (
      <ExternalLink
        href={node.url}
        className={cn(
          BUTTON_CLASS,
          "gap-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          styleClass
        )}
        data-testid="inbound-a2ui-link-button"
      >
        <span className="min-w-0">{label}</span>
        <ExternalLinkIcon className="h-3 w-3 shrink-0" aria-hidden />
      </ExternalLink>
    )
  }
  const hint = t("actionUnavailable", { platform: PLATFORM_NAME[source] ?? source })
  return (
    <button
      type="button"
      disabled
      title={hint}
      aria-label={`${label} (${hint})`}
      className={cn(BUTTON_CLASS, "cursor-not-allowed opacity-70", styleClass)}
      data-testid={node.actionId ? `inbound-a2ui-button-${node.actionId}` : undefined}
      data-inert="true"
    >
      <span className="min-w-0">{label}</span>
    </button>
  )
}

function UnavailableImage({ alt, source }: { alt?: string; source: Source }) {
  const t = useTranslations("inbox.inboundA2UI")
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground"
      data-testid="inbound-a2ui-image-unavailable"
    >
      <ImageOffIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        {alt?.trim() ? `${alt.trim()} · ` : ""}
        {t("imageUnavailable", { platform: PLATFORM_NAME[source] ?? source })}
      </span>
    </span>
  )
}

function RawJsonDetails({ payload, label }: { payload: unknown; label?: string }) {
  const t = useTranslations("inbox.inboundA2UI")
  const [open, setOpen] = useState(false)
  const contentId = useId()
  let json: string | undefined
  let failed = false
  if (open) {
    try {
      json = JSON.stringify(payload, null, 2)
    } catch {
      failed = true
    }
  }
  return (
    <div className="rounded-md bg-muted/30 px-2 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={contentId}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        data-testid="inbound-a2ui-raw-toggle"
      >
        {open ? (
          <ChevronDownIcon className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRightIcon className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="min-w-0">{label ?? t("rawPayload")}</span>
      </button>
      {open && (
        <div id={contentId}>
          {failed ? (
            <p role="status" className="mt-1 text-xs text-muted-foreground">
              {t("rawUnavailable")}
            </p>
          ) : (
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-background p-2 text-[11px]">
              {json}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
