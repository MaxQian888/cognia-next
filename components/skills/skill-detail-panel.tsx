"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useSkillsStore } from "@/stores/skills"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { getSkill } from "@/lib/db/skills"
import { SkillDetail } from "./skill-detail"

/**
 * Mobile-only Sheet that holds the detail view. The trigger lives elsewhere
 * (rows in the list pane); the sheet itself reads `detailSkillId` from the
 * store and closes by calling `closeDetail()`. On desktop the detail renders
 * inline in the master-detail right pane instead, so the Sheet never mounts.
 */
export function SkillDetailPanel() {
  const t = useTranslations("skills")
  const isMobile = useIsMobile()
  const detailSkillId = useSkillsStore((s) => s.detailSkillId)
  const closeDetail = useSkillsStore((s) => s.closeDetail)
  const skill = useLiveQuery(
    () => (detailSkillId ? getSkill(detailSkillId) : Promise.resolve(undefined)),
    [detailSkillId]
  )

  if (!isMobile) return null

  return (
    <Sheet open={detailSkillId !== null} onOpenChange={(o) => !o && closeDetail()}>
      <SheetContent side="right" className="w-full p-0 safe-area-pb sm:max-w-2xl">
        <SheetHeader className="sr-only">
          <SheetTitle>{skill?.name ?? t("fallbackName")}</SheetTitle>
          <SheetDescription>{skill?.description ?? ""}</SheetDescription>
        </SheetHeader>
        {skill ? (
          <SkillDetail skill={skill} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("loading")}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
