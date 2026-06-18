"use client"

/**
 * Mobile Discover card action sheet.
 *
 * Long-pressing a character / team / skill card opens this bottom sheet. It
 * surfaces the same "Share via link" flow the desktop inspector already
 * exposes (`DiscoverShareButton`, which carries its own PII gate +
 * `ShareLinkDialog`) so the mobile legacy cards — which bypass the shared
 * grid inspector — reach feature parity without duplicating the share logic.
 *
 * The body is intentionally a single, extensible action column: future
 * per-card actions (favorite, delete, …) slot in alongside the share button.
 */

import { useTranslations } from "next-intl"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { DiscoverShareButton } from "@/components/discover/discover-share-button"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

export interface DiscoverCardActionsProps {
  /** The card whose actions are shown. `null` keeps the sheet closed. */
  item: DiscoverItem | null
  onOpenChange: (open: boolean) => void
}

export function DiscoverCardActions({ item, onOpenChange }: DiscoverCardActionsProps) {
  const t = useTranslations("discover.cardActions")
  const named = item?.data as { name?: unknown } | undefined
  const heading = typeof named?.name === "string" && named.name ? named.name : t("title")
  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" data-testid="discover-card-actions-sheet">
        <SheetHeader>
          <SheetTitle className="truncate">{heading}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 p-4">
          {item ? <DiscoverShareButton item={item} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
