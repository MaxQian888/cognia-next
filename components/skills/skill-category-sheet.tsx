"use client"

import { useTranslations } from "next-intl"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useSkillsStore } from "@/stores/skills"
import { SkillCategoryButtonList } from "./skill-category-sidebar"

interface Props {
  total: number
  countsByCategory: Record<string, number>
  countsBySource: Record<string, number>
}

/**
 * Mobile-only category navigator. Mirrors the desktop `SkillCategorySidebar`
 * via the shared `SkillCategoryButtonList`. Auto-closes on selection so the
 * user lands directly back on the filtered grid.
 */
export function SkillCategorySheet({ total, countsByCategory, countsBySource }: Props) {
  const t = useTranslations("skills")
  const open = useSkillsStore((s) => s.categorySheetOpen)
  const setOpen = useSkillsStore((s) => s.setCategorySheetOpen)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="left" className="w-72 p-0 sm:w-80">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{t("panel.categoriesSheetTitle")}</SheetTitle>
          <SheetDescription>{t("panel.categoriesSheetDescription")}</SheetDescription>
        </SheetHeader>
        <div className="px-2 py-3 text-sm">
          <SkillCategoryButtonList
            total={total}
            countsByCategory={countsByCategory}
            countsBySource={countsBySource}
            onSelect={() => setOpen(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
