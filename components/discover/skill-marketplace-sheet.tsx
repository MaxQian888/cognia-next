"use client"

/**
 * Bottom/side Sheet that surfaces the skill marketplace from inside the
 * Discover page — parity with `plugin-marketplace-sheet.tsx`. Embeds the
 * existing self-contained `<SkillMarketplace />` (which owns `useSkillMarketplace`
 * and the install pipeline) so the install flow runs through the same code path
 * as `/skills` — no new orchestration.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { SkillMarketplace } from "@/components/skills/skill-marketplace"
import { cn } from "@/lib/utils"

export interface SkillMarketplaceSheetProps {
  /** Optional trigger override. Defaults to a "Browse skills" button. */
  trigger?: React.ReactNode
  className?: string
}

export function SkillMarketplaceSheet({ trigger, className }: SkillMarketplaceSheetProps) {
  const t = useTranslations("discover")
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="outline"
            className={cn("gap-2", className)}
            data-testid="discover-skill-marketplace-trigger"
          >
            <SparklesIcon className="size-4" />
            {t("skillMarketplace.browse")}
          </Button>
        )}
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 sm:max-w-md lg:max-w-2xl"
        data-testid="discover-skill-marketplace-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t("skillMarketplace.title")}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <SkillMarketplace />
        </div>
      </SheetContent>
    </Sheet>
  )
}
