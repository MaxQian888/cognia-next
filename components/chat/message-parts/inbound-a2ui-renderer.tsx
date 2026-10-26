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
 * a `<details>` block as raw JSON so operators can verify the mapper
 * didn't drop content.
 */

import { useTranslations } from "next-intl"
import Image from "next/image"
import { useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, ImageOffIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ExternalLink } from "@/components/shared/external-link"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
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
    <RendererErrorBoundary rendererName="inbound-a2ui" className={className}>
      <InboundA2UIBlockView block={block} className={className} />
    </RendererErrorBoundary>
  )
}

function InboundA2UIBlockView({ block, className }: InboundA2UIRendererProps) {
  // Mappers usually repeat the card title as the first heading; show it once.
  const first = block.body[0]
  const titleInBody = first?.kind === "heading" && first.text === block.title
  return (
    <div
      data-testid="inbound-a2ui"
      data-source={block.source}
      className={cn("rounded-md border bg-muted/20 px-3 py-2 text-sm space-y-2", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="text-[10px]">
          {SOURCE_LABEL[block.source] ?? block.source}
        </Badge>
        {block.title && !titleInBody && <span className="text-xs font-medium">{block.title}</span>}
      </div>
      <div className="space-y-1.5">
        {block.body.map((node, idx) => (
          <NodeRenderer key={idx} node={node} source={block.source} />
        ))}
      </div>
      {block.raw !== undefined && <RawJsonDetails payload={block.raw} />}
    </div>
  )
}

type Source = InboundA2UIBlock["source"]

function NodeRenderer({ node, source }: { node: InboundA2UINode; source: Source }) {
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
      if (!isDisplayableInboundMediaUrl(node.url)) {
        return <UnavailableImage alt={node.alt} source={source} />
      }
      return (
        <Image
          src={node.url}
          alt={node.alt ?? ""}
          width={0}
          height={0}
          sizes="100vw"
          className="h-auto max-h-64 w-auto max-w-full rounded border object-contain"
        />
      )
    case "link":
      if (!isNavigableInboundUrl(node.href)) {
        return <span className="text-xs text-muted-foreground">{node.label}</span>
      }
      return (
        <ExternalLink
          href={node.href}
          className="inline-flex items-center gap-1 rounded-sm text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {node.label}
          <ExternalLinkIcon className="h-3 w-3" aria-hidden />
        </ExternalLink>
      )
    case "button":
      return <ButtonNode node={node} source={source} />
    case "divider":
      return <hr className="border-border/60" />
    case "row":
      return (
        <div className="flex flex-wrap items-center gap-2">
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} />
          ))}
        </div>
      )
    case "column":
      return (
        <div className="flex flex-col gap-1">
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} />
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
              <NodeRenderer node={child} source={source} />
            </li>
          ))}
        </Tag>
      )
    }
    case "card":
      return (
        <div className="rounded-md border bg-background px-3 py-2 space-y-1">
          {node.title && <p className="text-sm font-semibold">{node.title}</p>}
          {node.subtitle && <p className="text-xs text-muted-foreground">{node.subtitle}</p>}
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} />
          ))}
        </div>
      )
    case "alert":
      return (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            node.tone === "info" && "border-sky-300 bg-sky-50 dark:bg-sky-950/30",
            node.tone === "warning" && "border-amber-300 bg-amber-50 dark:bg-amber-950/30",
            node.tone === "success" && "border-green-300 bg-green-50 dark:bg-green-950/30",
            node.tone === "error" && "border-destructive/40 bg-destructive/10"
          )}
        >
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} source={source} />
          ))}
        </div>
      )
    case "mention":
      return (
        <Badge variant="secondary" className="text-[11px]">
          @{node.resolved ?? node.handle}
        </Badge>
      )
    case "reply_context":
      return (
        <p className="rounded-l-md border-l-2 border-muted-foreground/30 pl-2 text-xs italic text-muted-foreground">
          ↩ {node.preview ?? `reply to ${node.replyToMessageId}`}
        </p>
      )
    case "raw_json":
      return <RawJsonDetails payload={node.payload} label={node.label} />
  }
}

const BUTTON_CLASS = "inline-flex h-7 items-center rounded-md border px-2 text-xs"

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
  if (node.url && !node.actionId && isNavigableInboundUrl(node.url)) {
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
        {label}
        <ExternalLinkIcon className="h-3 w-3" aria-hidden />
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
      {label}
    </button>
  )
}

function UnavailableImage({ alt, source }: { alt?: string; source: Source }) {
  const t = useTranslations("inbox.inboundA2UI")
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground"
      data-testid="inbound-a2ui-image-unavailable"
    >
      <ImageOffIcon className="h-3.5 w-3.5" aria-hidden />
      {alt?.trim() ? `${alt.trim()} · ` : ""}
      {t("imageUnavailable", { platform: PLATFORM_NAME[source] ?? source })}
    </span>
  )
}

function RawJsonDetails({ payload, label }: { payload: unknown; label?: string }) {
  const t = useTranslations("inbox.inboundA2UI")
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md bg-muted/30 px-2 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-sm text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        data-testid="inbound-a2ui-raw-toggle"
      >
        {open ? (
          <ChevronDownIcon className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronRightIcon className="h-3 w-3" aria-hidden />
        )}
        {label ?? t("rawPayload")}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-background p-2 text-[11px]">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  )
}
