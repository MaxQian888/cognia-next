// Icon lookup for pet shop-catalog items (`PetShopItem.icon` name → lucide
// component). Shared by the shop tab and the panel's inventory quick-use strip
// so an item renders identically everywhere; unknown names fall back to
// sparkles.

import {
  BoxIcon,
  CherryIcon,
  SparklesIcon,
  StarIcon,
  UtensilsCrossedIcon,
  VolleyballIcon,
  type LucideIcon,
} from "lucide-react"

export const PET_ITEM_ICONS: Record<string, LucideIcon> = {
  Cherry: CherryIcon,
  UtensilsCrossed: UtensilsCrossedIcon,
  Volleyball: VolleyballIcon,
  Box: BoxIcon,
  Star: StarIcon,
}

export function petItemIcon(name: string): LucideIcon {
  return PET_ITEM_ICONS[name] ?? SparklesIcon
}
