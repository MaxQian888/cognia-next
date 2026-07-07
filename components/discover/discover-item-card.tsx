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
  LayoutTemplateIcon,
  PlugIcon,
  PuzzleIcon,
  ScanTextIcon,
  SparklesIcon,
  StarIcon,
  TerminalIcon,
  UsersIcon,
  UsersRoundIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import type { DiscoverViewMode } from "@/lib/discover/categories"
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
    case "slashCommand": {
      const c = item.data
      return {
        name: c.name,
        description: c.description,
        builtIn: c.source === "builtin",
        badge: c.source === "plugin" ? "plugin" : (c.shortcut ?? undefined),
        avatar: { kind: "icon", Icon: TerminalIcon },
      }
    }
    case "mcpPreset": {
      const p = item.data
      return {
        name: p.name,
        description: p.description,
        builtIn: true,
        badge: p.transport,
        // The preset ships a glyph/emoji; render it in a tinted avatar.
        avatar: { kind: "color", color: "#475569", glyph: p.icon },
      }
    }
    case "teamTemplate": {
      const tpl = item.data
      return {
        name: tpl.name,
        description: tpl.description,
        builtIn: tpl.isBuiltIn,
        badge: tpl.category,
        avatar: { kind: "icon", Icon: LayoutTemplateIcon },
      }
    }
    case "externalAgentPreset": {
      const p = item.data
      return {
        name: p.name,
        description: p.description,
        builtIn: true,
        badge: p.tags[0],
        avatar: { kind: "icon", Icon: BotIcon },
      }
    }
    case "subagent": {
      const s = item.data
      // Host-bundled dispatchable ids carry no `<pluginId>:`/`template:` prefix.
      return {
        name: s.name,
        description: s.description,
        builtIn: !item.id.includes(":"),
        badge: "subagent",
        avatar: { kind: "icon", Icon: BotIcon },
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
  /** Layout variant — defaults to the horizontal "list" row. */
  view?: DiscoverViewMode
  /** Whether this item is favorited. Omit to hide the star entirely. */
  favorited?: boolean
  /** Toggle handler — when provided, a star overlay is rendered. */
  onToggleFavorite?: () => void
  className?: string
}

function Avatars({ meta, size }: { meta: ItemMeta; size: "sm" | "md" | "lg" }) {
  const dim = size === "lg" ? "size-12" : size === "sm" ? "size-8" : "size-10"
  const iconDim = size === "lg" ? "size-6" : size === "sm" ? "size-4" : "size-5"
  return (
    <div className="shrink-0">
      {meta.avatar.kind === "color" ? (
        <Avatar className={dim}>
          <AvatarFallback
            style={{ backgroundColor: meta.avatar.color }}
            className="text-sm"
            aria-hidden={meta.avatar.glyph ? "true" : undefined}
          >
            {meta.avatar.glyph}
          </AvatarFallback>
        </Avatar>
      ) : (
        <div
          className={cn(
            "flex items-center justify-center rounded-md bg-secondary text-secondary-foreground",
            dim
          )}
        >
          <meta.avatar.Icon className={iconDim} />
        </div>
      )}
    </div>
  )
}

function CardBadges({ meta, builtInLabel }: { meta: ItemMeta; builtInLabel: string }) {
  return (
    <>
      {meta.builtIn ? (
        <Badge variant="outline" className="text-[10px]">
          {builtInLabel}
        </Badge>
      ) : null}
      {meta.badge ? (
        <Badge variant="secondary" className="text-[10px]">
          {meta.badge}
        </Badge>
      ) : null}
    </>
  )
}

export function DiscoverItemCard({
  item,
  selected,
  onSelect,
  view = "list",
  favorited,
  onToggleFavorite,
  className,
}: DiscoverItemCardProps) {
  const t = useTranslations("discover")
  const meta = useItemMeta(item)
  const isGrid = view === "grid"
  const isCompact = view === "compact"

  return (
    <div className={cn("relative", isGrid ? "h-full" : "w-full", className)}>
      <Button
        type="button"
        variant="ghost"
        onClick={onSelect}
        data-testid={`discover-item-${item.kind}-${item.id}`}
        aria-pressed={selected}
        className={cn(
          "h-auto w-full rounded-md border border-border bg-card text-left font-normal",
          "transition-colors hover:bg-muted/50 active:bg-muted/60",
          selected && "border-primary ring-1 ring-primary/40 hover:bg-muted/30",
          onToggleFavorite && !isGrid && "pr-9",
          isGrid
            ? "h-full flex-col items-start justify-start gap-2 p-3"
            : isCompact
              ? "items-center justify-start gap-2 p-2"
              : "items-start justify-start gap-3 p-3"
        )}
      >
        <Avatars meta={meta} size={isGrid ? "lg" : isCompact ? "sm" : "md"} />
        <div className={cn("flex min-w-0 flex-col gap-0.5", isGrid ? "w-full" : "flex-1")}>
          <div className="flex w-full items-center gap-2">
            <span
              className={cn(
                "truncate font-medium",
                isCompact ? "text-xs" : "text-sm",
                isGrid && onToggleFavorite && "pr-6"
              )}
            >
              {meta.name}
            </span>
            <CardBadges meta={meta} builtInLabel={t("builtInBadge")} />
          </div>
          {meta.description && !isCompact ? (
            <span
              className={cn(
                "text-xs text-muted-foreground",
                isGrid ? "line-clamp-3" : "line-clamp-2"
              )}
            >
              {meta.description}
            </span>
          ) : null}
        </div>
      </Button>
      {onToggleFavorite ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          aria-label={favorited ? t("favorite.remove") : t("favorite.add")}
          aria-pressed={favorited}
          data-testid={`discover-favorite-${item.kind}-${item.id}`}
          className={cn(
            "absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted-foreground",
            "transition-colors hover:bg-muted hover:text-foreground",
            favorited && "text-amber-500 hover:text-amber-500"
          )}
        >
          <StarIcon className={cn("size-4", favorited && "fill-current")} />
        </button>
      ) : null}
    </div>
  )
}
