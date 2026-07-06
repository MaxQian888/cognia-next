"use client"

/**
 * Renders an InboundA2UIBlock (produced by adapter inbound-to-a2ui
 * mappers) in the Inbox detail pane.
 *
 * Designed to be a structural mirror of A2UI's component vocabulary so
 * the same visual primitives that render outbound assistant surfaces
 * also show inbound platform-native UI. Buttons preserve their `url` /
 * `actionId` so the existing callback-binding round-trip (bus
 * `dispatchConnectorCallback`) keeps the inbound side interactive when
 * the platform supports it.
 *
 * Unrecognised structure from the original payload is rendered behind
 * a `<details>` block as raw JSON so operators can verify the mapper
 * didn't drop content.
 */

import { useTranslations } from "next-intl"
import Image from "next/image"
import { useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import type {
  InboundA2UIBlock,
  InboundA2UINode,
} from "@/lib/connectors/adapters/_shared/inbound-a2ui-types"

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

export interface InboundA2UIRendererProps {
  block: InboundA2UIBlock
  className?: string
}

export function InboundA2UIRenderer({ block, className }: InboundA2UIRendererProps) {
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
        {block.title && <span className="text-xs font-medium">{block.title}</span>}
      </div>
      <div className="space-y-1.5">
        {block.body.map((node, idx) => (
          <NodeRenderer key={idx} node={node} />
        ))}
      </div>
      {block.raw !== undefined && <RawJsonDetails payload={block.raw} />}
    </div>
  )
}

function NodeRenderer({ node }: { node: InboundA2UINode }) {
  switch (node.kind) {
    case "text":
      return (
        <p
          className={cn(
            "text-sm leading-relaxed",
            node.emphasis === "muted" && "text-xs text-muted-foreground",
            node.emphasis === "bold" && "font-medium",
            node.emphasis === "italic" && "italic",
            node.emphasis === "code" && "font-mono text-xs"
          )}
        >
          {node.text}
        </p>
      )
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
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-sm text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {node.label}
          <ExternalLinkIcon className="h-3 w-3" aria-hidden />
        </a>
      )
    case "button":
      return (
        <button
          type="button"
          disabled
          title={node.actionId ?? node.url ?? ""}
          className={cn(
            "inline-flex h-7 items-center rounded-md border px-2 text-xs",
            "cursor-not-allowed opacity-70",
            node.style === "primary" && "border-primary/40 bg-primary/10",
            node.style === "danger" && "border-destructive/40 bg-destructive/10"
          )}
          data-testid={node.actionId ? `inbound-a2ui-button-${node.actionId}` : undefined}
        >
          {node.label}
        </button>
      )
    case "divider":
      return <hr className="border-border/60" />
    case "row":
      return (
        <div className="flex flex-wrap items-center gap-2">
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} />
          ))}
        </div>
      )
    case "column":
      return (
        <div className="flex flex-col gap-1">
          {node.children.map((child, idx) => (
            <NodeRenderer key={idx} node={child} />
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
              <NodeRenderer node={child} />
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
            <NodeRenderer key={idx} node={child} />
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
            <NodeRenderer key={idx} node={child} />
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
