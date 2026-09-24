"use client"

/**
 * The Discover item detail sheet: what `?item=<id>` opens, on every tier.
 *
 * The desktop body used to show the selected item in its right rail only.
 * Below `lg` that rail folds into an overlay Sheet the body never opened, so a
 * card click (or a pasted `?item=char_*` link) updated the URL and scrolled the
 * grid while no detail surface appeared; the compact body only opened its
 * bottom Sheet for four grid categories. This component is the one detail
 * surface both bodies mount, controlled purely by the URL:
 *
 *  - open while `itemId` is set, closed otherwise, so browser Back/Forward
 *    (which only move the URL) close and re-open it;
 *  - dismissing it (close button, Escape, outside click) calls `onClose`,
 *    which clears `?item=`.
 *
 * Resolution: the item is looked up in the list the user picked it from
 * (`items`). A cold deep link can name an item the current view does not list
 * (no `?category=`, a narrowed filter), so once that list has loaded and the
 * id is still unknown, the sheet falls back to a cross-kind lookup. It reuses
 * the favorites aggregation of `useDiscoverQuery`, which reads every kind and
 * keeps the keys it is given: handing it `${kind}:${id}` for every kind returns
 * exactly the items carrying that id. While nothing needs resolving the hook
 * runs on the For You view, which it does not materialize, so it installs no
 * Dexie subscription.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, SearchXIcon, XIcon } from "lucide-react"

import { DiscoverInspector } from "@/components/discover/discover-inspector"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { favoriteKey } from "@/hooks/discover/use-discover-favorites"
import { useDiscoverQuery, type DiscoverItem } from "@/hooks/discover/use-discover-query"
import { FAVORITES_CATEGORY, FORYOU_CATEGORY, type DiscoverView } from "@/lib/discover/categories"
import { cn } from "@/lib/utils"

/**
 * Every Discover item kind. A `Record` keyed by the union so adding a kind to
 * `DiscoverItem` without listing it here is a type error, not a deep link that
 * silently never resolves.
 */
const DISCOVER_ITEM_KINDS: Readonly<Record<DiscoverItem["kind"], true>> = {
  character: true,
  team: true,
  skill: true,
  plugin: true,
  mcpServer: true,
  connector: true,
  docsProvider: true,
  externalService: true,
  integration: true,
  ocrProvider: true,
  workflowTemplate: true,
  twinSource: true,
  twinDraft: true,
  slashCommand: true,
  mcpPreset: true,
  teamTemplate: true,
  externalAgentPreset: true,
  subagent: true,
}

/** `${kind}:${id}` for every kind: the key set that selects `id` in any kind. */
export function discoverItemKeysForId(id: string): ReadonlySet<string> {
  return new Set(Object.keys(DISCOVER_ITEM_KINDS).map((kind) => favoriteKey(kind, id)))
}

const NO_KEYS: ReadonlySet<string> = new Set()

export type DiscoverItemResolution =
  | { status: "closed" }
  | { status: "loading" }
  | { status: "found"; item: DiscoverItem }
  | { status: "missing" }

/**
 * Resolve `itemId` against the visible list first, then across every kind.
 * Exported for the sheet's tests; the sheet is its only production caller.
 */
export function useDiscoverItemResolution(
  itemId: string | null,
  items: readonly DiscoverItem[],
  listLoading: boolean
): DiscoverItemResolution {
  const visible = itemId ? (items.find((item) => item.id === itemId) ?? null) : null
  const needsFallback = itemId !== null && visible === null && !listLoading
  const keys = useMemo(
    () => (needsFallback && itemId ? discoverItemKeysForId(itemId) : NO_KEYS),
    [needsFallback, itemId]
  )
  const fallbackView: DiscoverView = needsFallback ? FAVORITES_CATEGORY : FORYOU_CATEGORY
  const fallback = useDiscoverQuery(fallbackView, "", { favoriteKeys: keys })

  if (itemId === null) return { status: "closed" }
  if (visible) return { status: "found", item: visible }
  if (listLoading) return { status: "loading" }
  const resolved = fallback.items.find((item) => item.id === itemId)
  if (resolved) return { status: "found", item: resolved }
  if (fallback.loading) return { status: "loading" }
  return { status: "missing" }
}

export interface DiscoverItemSheetProps {
  /** The `?item=` id, or null when no detail is open. */
  itemId: string | null
  /** The list the user picked from (a category, favorites, or For You). */
  items: readonly DiscoverItem[]
  /** True while `items` is still on its first read. */
  loading: boolean
  /** The category the page is showing, for the detail's category context. */
  category: DiscoverView
  /** Clears `?item=`. Called for every dismissal path. */
  onClose: () => void
  /** `bottom` on the compact body, `right` elsewhere. */
  side?: "right" | "bottom"
}

export function DiscoverItemSheet({
  itemId,
  items,
  loading,
  category,
  onClose,
  side = "right",
}: DiscoverItemSheetProps) {
  const resolution = useDiscoverItemResolution(itemId, items, loading)

  return (
    <Sheet open={itemId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side={side}
        // The inspector carries its own close button next to the favorite
        // star; the Sheet's default one would be a second X in the same row.
        showCloseButton={false}
        className={cn("gap-0 p-0", side === "right" ? "w-full sm:max-w-md" : "max-h-[85vh]")}
        data-testid="discover-item-sheet"
      >
        {resolution.status === "found" ? (
          <DiscoverInspector
            category={category}
            itemId={resolution.item.id}
            items={[resolution.item]}
            onClose={onClose}
            presentation="sheet"
            className="flex min-h-0 flex-1 flex-col"
          />
        ) : resolution.status === "loading" ? (
          <UnresolvedState kind="loading" onClose={onClose} />
        ) : resolution.status === "missing" ? (
          <UnresolvedState kind="missing" onClose={onClose} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function UnresolvedState({ kind, onClose }: { kind: "loading" | "missing"; onClose: () => void }) {
  const t = useTranslations("discover")
  const Icon = kind === "loading" ? Loader2Icon : SearchXIcon
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid={`discover-item-sheet-${kind}`}
      aria-busy={kind === "loading" ? true : undefined}
    >
      <SheetHeader className="flex-row items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <SheetTitle className="text-sm">
            {kind === "loading" ? t("inspector.loadingTitle") : t("inspector.missingTitle")}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {kind === "loading"
              ? t("inspector.loadingDescription")
              : t("inspector.missingDescription")}
          </SheetDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t("inspector.close")}
          data-testid="discover-item-sheet-close"
        >
          <XIcon className="size-4" />
        </Button>
      </SheetHeader>
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        <Icon aria-hidden className={cn("size-6", kind === "loading" && "animate-spin")} />
      </div>
    </div>
  )
}
