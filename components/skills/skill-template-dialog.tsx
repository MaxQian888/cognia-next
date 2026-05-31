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
import { SKILL_TEMPLATES, templateToSkillSeed } from "@/lib/skills/templates"
import { useSkillsStore } from "@/stores/skills"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Template gallery — picking a card opens the create editor pre-filled with the
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
        <div className="grid max-h-[55vh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {SKILL_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              data-testid={`skill-template-${tpl.id}`}
              className="group flex flex-col items-start gap-1 rounded-md border bg-card p-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent"
              onClick={() => {
                openCreate(templateToSkillSeed(tpl))
                onOpenChange(false)
              }}
            >
              <div className="flex w-full items-center gap-2">
                <span className="flex-1 truncate font-medium">{tpl.name}</span>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {tpl.category}
                </Badge>
              </div>
              <p className="line-clamp-2 text-[11px] text-muted-foreground">{tpl.description}</p>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
