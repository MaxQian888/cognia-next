"use client"

import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ItemGroup, ItemSeparator } from "@/components/ui/item"
import { SKILL_TEMPLATES, templateToSkillSeed } from "@/lib/skills/templates"
import { useSkillsStore } from "@/stores/skills"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Template gallery — picking a row opens the create editor pre-filled with the
 * template's name / description / body / category / tags (via the store's
 * `openCreate` seed). The user reviews and saves through the normal flow.
 */
export function SkillTemplateDialog({ open, onOpenChange }: Props) {
  const t = useTranslations("skills.templates")
  const openCreate = useSkillsStore((s) => s.openCreate)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>
        <ItemGroup className="max-h-[55vh] overflow-y-auto border-y">
          {SKILL_TEMPLATES.map((tpl) => (
            <div key={tpl.id} role="listitem">
              <Button
                type="button"
                variant="ghost"
                data-testid={`skill-template-${tpl.id}`}
                className="h-auto w-full flex-col items-stretch gap-1 whitespace-normal rounded-none px-3 py-3 text-left"
                onClick={() => {
                  openCreate(templateToSkillSeed(tpl))
                  onOpenChange(false)
                }}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="flex-1 truncate font-medium">{tpl.name}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {tpl.category}
                  </Badge>
                </span>
                <span className="line-clamp-2 text-[11px] font-normal text-muted-foreground">
                  {tpl.description}
                </span>
              </Button>
              <ItemSeparator role="presentation" />
            </div>
          ))}
        </ItemGroup>
      </DialogContent>
    </Dialog>
  )
}
