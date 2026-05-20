"use client"

/**
 * Generic display card for any `DiscoverItem` kind, used by the desktop
 * grid. Clicking sets the URL `?item=` param via the caller's onSelect.
 * The actual "do the thing" actions (open chat, navigate to /agent-teams,
 * enable/disable skill / plugin / mcp server) happen from the Inspector —
 * see `discover-inspector.tsx` — so this card stays purely a selector.
 */

import { useLocale, useTranslations } from "next-intl"
import {
  BotIcon,
  FileEditIcon,
  InboxIcon,
  PlugIcon,
  PuzzleIcon,
  ScanTextIcon,
  SparklesIcon,
  UsersIcon,
  UsersRoundIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import { cn } from "@/lib/utils"

interface ItemMeta {
  name: string
  description: string | undefined
  builtIn: boolean
  /** Optional small label rendered as a secondary badge. */
  badge: string | undefined
  avatar:
    | { kind: "color"; color: string; glyph: string }
    | { kind: "icon"; Icon: React.ComponentType<{ className?: string }> }
}

/**
 * Resolve a `DiscoverItem` into the simple display fields the card renders.
 * Pulled into a hook so locale-aware kinds (workflow templates,
 * connectors) can read from `useLocale()` / `useTranslations()`.
 */
function useItemMeta(item: DiscoverItem): ItemMeta {
  const t = useTranslations("discover")
  const locale = useLocale()
  switch (item.kind) {
    case "character": {
      const c = item.data
      return {
        name: c.name,
        description: c.description,
        builtIn: Boolean(c.isBuiltIn),
        badge: undefined,
        avatar: {
          kind: "color",
          color: c.avatarColor ?? "#888",
          glyph: c.avatarEmoji ?? c.name.slice(0, 2).toUpperCase(),
        },
      }
    }
    case "team": {
      const team = item.data
      return {
        name: team.name,
        description: team.description,
        builtIn: Boolean(team.isBuiltIn),
        badge: undefined,
        avatar: { kind: "icon", Icon: UsersRoundIcon },
      }
    }
    case "skill": {
      const s = item.data
      return {
        name: s.name,
        description: s.description,
        builtIn: Boolean(s.isBuiltIn),
        badge: s.status === "disabled" ? t("inspector.disable") : undefined,
        avatar: { kind: "icon", Icon: SparklesIcon },
      }
    }
    case "plugin": {
      const p = item.data
      return {
        name: p.name || p.id,
        description: p.version ? `v${p.version}` : undefined,
        builtIn: p.source === "builtin",
        badge: p.enabled ? undefined : t("inspector.disable"),
        avatar: { kind: "icon", Icon: PuzzleIcon },
      }
    }
    case "mcpServer": {
      const s = item.data
      return {
        name: s.name,
        description: s.transport,
        builtIn: !s.pluginId,
        badge: s.enabled ? undefined : t("inspector.disable"),
        avatar: { kind: "icon", Icon: WrenchIcon },
      }
    }
    case "connector": {
      const meta = item.data
      return {
        name: t(`connectorLabels.${meta.type}`),
        description: t(`connectorDescriptions.${meta.type}`),
        builtIn: meta.status === "stable",
        badge:
          meta.status === "planned"
            ? t("connectorStatus.planned")
            : meta.status === "beta"
              ? t("connectorStatus.beta")
              : undefined,
        avatar: { kind: "icon", Icon: PlugIcon },
      }
    }
    case "ocrProvider": {
      const p = item.data
      return {
        name: p.label,
        description: t(`ocrCategories.${p.category}`),
        builtIn: p.category === "local",
        badge: p.credentialKeys.length === 0 ? undefined : t("ocrBadge.needsCredentials"),
        avatar: { kind: "icon", Icon: ScanTextIcon },
      }
    }
    case "workflowTemplate": {
      const tpl = item.data
      const localeKey: "en" | "zh-CN" = locale === "zh-CN" ? "zh-CN" : "en"
      return {
        name: tpl.label[localeKey] ?? tpl.label.en,
        description: tpl.description[localeKey] ?? tpl.description.en,
        builtIn: true,
        badge: tpl.tags && tpl.tags.length > 0 ? tpl.tags[0] : undefined,
        avatar: { kind: "icon", Icon: WorkflowIcon },
      }
    }
    case "twinSource": {
      const s = item.data
      return {
        name: s.title,
        description: t("card.twinSourceDescription", { kind: s.kind, chunks: s.chunkCount }),
        builtIn: false,
        badge: s.status,
        avatar: { kind: "icon", Icon: InboxIcon },
      }
    }
    case "twinDraft": {
      const d = item.data
      const dataName =
        typeof d.payload?.data?.name === "string" ? (d.payload.data.name as string) : undefined
      return {
        name: dataName ?? t("card.twinDraftFallbackName", { kind: d.kind }),
        description: d.provenance?.rationale,
        builtIn: false,
        badge: d.kind,
        avatar: { kind: "icon", Icon: d.kind === "skill" ? SparklesIcon : FileEditIcon },
      }
    }
    default: {
      // Exhaustiveness fallback for the never branch when new kinds land.
      const exhaustive: never = item
      void BotIcon
      return {
        name: (exhaustive as { id?: string }).id ?? "?",
        description: undefined,
        builtIn: false,
        badge: undefined,
        avatar: { kind: "icon", Icon: UsersIcon },
      }
    }
  }
}

export interface DiscoverItemCardProps {
  item: DiscoverItem
  selected: boolean
  onSelect: () => void
  className?: string
}

export function DiscoverItemCard({ item, selected, onSelect, className }: DiscoverItemCardProps) {
  const t = useTranslations("discover")
  const meta = useItemMeta(item)
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      data-testid={`discover-item-${item.kind}-${item.id}`}
      aria-pressed={selected}
      className={cn(
        "h-auto w-full items-start justify-start gap-3 rounded-md border border-border bg-card p-3 text-left font-normal",
        "transition-colors hover:bg-muted/50 active:bg-muted/60",
        selected && "border-primary ring-1 ring-primary/40 hover:bg-muted/30",
        className
      )}
    >
      <div className="shrink-0">
        {meta.avatar.kind === "color" ? (
          <Avatar className="size-10">
            <AvatarFallback
              style={{ backgroundColor: meta.avatar.color }}
              className="text-sm"
              aria-hidden={meta.avatar.glyph ? "true" : undefined}
            >
              {meta.avatar.glyph}
            </AvatarFallback>
          </Avatar>
        ) : (
          <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
            <meta.avatar.Icon className="size-5" />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{meta.name}</span>
          {meta.builtIn ? (
            <Badge variant="outline" className="text-[10px]">
              {t("builtInBadge")}
            </Badge>
          ) : null}
          {meta.badge ? (
            <Badge variant="secondary" className="text-[10px]">
              {meta.badge}
            </Badge>
          ) : null}
        </div>
        {meta.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{meta.description}</span>
        ) : null}
      </div>
    </Button>
  )
}
