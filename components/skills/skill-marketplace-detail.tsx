"use client"

import { useTranslations } from "next-intl"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"
import { SkillMarketplaceDetailContent } from "./skill-marketplace-detail-content"

interface Props {
  item: MarketplaceItem
  installed: boolean
  installing: boolean
  onClose: () => void
  onInstall: (item: MarketplaceItem) => void
  onUninstall: (item: MarketplaceItem) => void
}

/**
 * Mobile Sheet wrapper around `SkillMarketplaceDetailContent`. On desktop the
 * content renders inline in the Browse master-detail right pane instead.
 */
export function SkillMarketplaceDetail({
  item,
  installed,
  installing,
  onClose,
  onInstall,
  onUninstall,
}: Props) {
  const tMp = useTranslations("skills.marketplace")
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-2xl">
        <SheetHeader className="sr-only">
          <SheetTitle>{item.name}</SheetTitle>
          <SheetDescription>{item.description ?? tMp("title")}</SheetDescription>
        </SheetHeader>
        <SkillMarketplaceDetailContent
          item={item}
          installed={installed}
          installing={installing}
          onInstall={onInstall}
          onUninstall={onUninstall}
        />
      </SheetContent>
    </Sheet>
  )
}
