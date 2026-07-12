// Icon lookup for pet shop-catalog items (`PetShopItem.icon` name → lucide
// component). Shared by the shop tab and the panel's inventory quick-use strip
// so an item renders identically everywhere; unknown names fall back to
// sparkles.

import {
  BathIcon,
  BedDoubleIcon,
  BirdIcon,
  BoxIcon,
  BriefcaseMedicalIcon,
  CherryIcon,
  CookieIcon,
  CupSodaIcon,
  DiscIcon,
  FanIcon,
  FishIcon,
  GemIcon,
  GraduationCapIcon,
  HeartIcon,
  SparklesIcon,
  StarIcon,
  SunIcon,
  UtensilsCrossedIcon,
  VolleyballIcon,
  Wand2Icon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"

export const PET_ITEM_ICONS: Record<string, LucideIcon> = {
  Bath: BathIcon,
  BedDouble: BedDoubleIcon,
  Bird: BirdIcon,
  Box: BoxIcon,
  BriefcaseMedical: BriefcaseMedicalIcon,
  Cherry: CherryIcon,
  Cookie: CookieIcon,
  CupSoda: CupSodaIcon,
  Disc: DiscIcon,
  Fan: FanIcon,
  Fish: FishIcon,
  Gem: GemIcon,
  GraduationCap: GraduationCapIcon,
  Heart: HeartIcon,
  Star: StarIcon,
  Sun: SunIcon,
  UtensilsCrossed: UtensilsCrossedIcon,
  Volleyball: VolleyballIcon,
  Wand2: Wand2Icon,
  Zap: ZapIcon,
}

export function petItemIcon(name: string): LucideIcon {
  return PET_ITEM_ICONS[name] ?? SparklesIcon
}
