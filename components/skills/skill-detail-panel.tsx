"use client"

import { useLiveQuery } from "dexie-react-hooks"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useSkillsStore } from "@/stores/skills-store"
import { getSkill } from "@/lib/db/skills"
import { SkillDetail } from "./skill-detail"

/**
 * Sheet that holds the detail view. The trigger lives elsewhere (cards on
 * grid); the sheet itself reads `detailSkillId` from the store and closes by
 * calling `closeDetail()`.
 */
export function SkillDetailPanel() {
  const detailSkillId = useSkillsStore((s) => s.detailSkillId)
  const closeDetail = useSkillsStore((s) => s.closeDetail)
  const skill = useLiveQuery(
    () => (detailSkillId ? getSkill(detailSkillId) : Promise.resolve(undefined)),
    [detailSkillId]
  )

  return (
    <Sheet open={detailSkillId !== null} onOpenChange={(o) => !o && closeDetail()}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-2xl">
        <SheetHeader className="sr-only">
          <SheetTitle>{skill?.name ?? "Skill"}</SheetTitle>
          <SheetDescription>{skill?.description ?? ""}</SheetDescription>
        </SheetHeader>
        {skill ? (
          <SkillDetail skill={skill} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
