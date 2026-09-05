"use client"

/**
 * The left rail: every image in this message, and every version of the one
 * being edited.
 *
 * Versions are indented by their depth in the lineage so a chain reads as a
 * chain. The original is always first and always present, which is the visible
 * half of the non-destructive promise: whatever a model did, the thing you
 * started from is still one click away.
 */

import { useTranslations } from "next-intl"

import {
  AI_IMAGE_EDIT_OPERATIONS,
  type ImageEditOperation,
  type ImageLineage,
} from "@/lib/chat/image-edit/version"
import { isMediaRef } from "@/lib/db/message-media"
import { useMediaUrl } from "@/hooks/chat/use-media-url"
import { cn } from "@/lib/utils"

export interface VersionRailItem {
  /** The part's url, which identifies it. */
  url: string
  /**
   * A displayable URL, when the caller already has one.
   *
   * A version saved while the workbench is open has no rendered image yet, so
   * the rail resolves content-addressed references itself rather than showing
   * a broken thumbnail until the message re-renders.
   */
  displayUrl: string
  lineageId: string
  /** 0 for an original. */
  depth: number
  /** Empty for an original. */
  operations: string[]
}

export interface VersionRailProps {
  items: readonly VersionRailItem[]
  activeUrl: string | null
  onSelect: (url: string) => void
  /** Present while an unsaved edit is open on the active item. */
  draftLabel?: string | null
}

/** Flatten grouped lineages into the rail's rows. */
export function railItemsFromLineages(
  lineages: readonly ImageLineage[],
  resolveDisplayUrl: (url: string) => string
): VersionRailItem[] {
  return lineages.flatMap((lineage) =>
    lineage.entries.map((entry) => ({
      url: entry.url,
      displayUrl: resolveDisplayUrl(entry.url),
      lineageId: lineage.lineageId,
      depth: entry.depth,
      operations: entry.version?.operations ?? [],
    }))
  )
}

export function VersionRail({ items, activeUrl, onSelect, draftLabel }: VersionRailProps) {
  const t = useTranslations("chat.imageWorkbench")
  if (items.length === 0) return null

  return (
    <nav
      data-testid="workbench-version-rail"
      aria-label={t("rail.label")}
      className="flex shrink-0 gap-2 overflow-x-auto border-white/10 bg-black/70 p-2 lg:w-28 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden lg:border-r"
    >
      {items.map((item) => {
        const active = item.url === activeUrl
        const isOriginal = item.depth === 0
        // A version a model produced is worth distinguishing from one the user
        // cropped: it is the one they may want to compare against or discard.
        const byModel = item.operations.some((operation) =>
          AI_IMAGE_EDIT_OPERATIONS.includes(operation as ImageEditOperation)
        )
        return (
          <button
            key={item.url}
            type="button"
            data-testid="workbench-version-item"
            data-active={active || undefined}
            aria-pressed={active}
            aria-label={
              isOriginal
                ? t("rail.originalAria")
                : byModel
                  ? t("rail.aiVersionAria", { operations: item.operations.join(", ") })
                  : t("rail.versionAria", { operations: item.operations.join(", ") })
            }
            onClick={() => onSelect(item.url)}
            className={cn(
              "relative shrink-0 overflow-hidden rounded-md border-2 bg-white/5 outline-none transition-[border-color,opacity] focus-visible:ring-2 focus-visible:ring-white/70",
              "size-14 lg:h-16 lg:w-full",
              active ? "border-white opacity-100" : "border-transparent opacity-60 hover:opacity-90"
            )}
            style={{ marginInlineStart: item.depth > 0 ? Math.min(item.depth, 3) * 6 : 0 }}
          >
            <RailThumbnail url={item.url} fallback={item.displayUrl} />
            {isOriginal ? (
              <span className="absolute inset-x-0 bottom-0 bg-black/65 px-1 py-0.5 text-[10px] text-white/85">
                {t("rail.original")}
              </span>
            ) : byModel ? (
              <span
                data-testid="workbench-version-ai-badge"
                className="absolute inset-x-0 bottom-0 bg-black/65 px-1 py-0.5 text-[10px] text-white/85"
              >
                {t("rail.aiBadge")}
              </span>
            ) : null}
          </button>
        )
      })}
      {draftLabel ? (
        <span
          data-testid="workbench-version-draft"
          className="flex size-14 shrink-0 items-center justify-center rounded-md border-2 border-dashed border-white/40 px-1 text-center text-[10px] text-white/70 lg:h-16 lg:w-full"
        >
          {draftLabel}
        </span>
      ) : null}
    </nav>
  )
}

/**
 * One thumbnail, resolving a `cognia-media:` reference on its own.
 *
 * The thumbnail variant, not the canonical: this is a 56px tile, and decoding a
 * full 1568px frame for each row of the rail is the difference between a rail
 * that opens instantly and one that hitches.
 */
function RailThumbnail({ url, fallback }: { url: string; fallback: string }) {
  const resolved = useMediaUrl(isMediaRef(url) ? url : null, { thumbnail: true })
  const src = resolved.status === "ready" && resolved.url ? resolved.url : fallback
  if (!src || isMediaRef(src)) {
    return <span className="block size-full bg-white/10" />
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="size-full object-cover" draggable={false} />
}
