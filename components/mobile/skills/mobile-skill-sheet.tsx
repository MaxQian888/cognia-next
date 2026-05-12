"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { updateSkill } from "@/lib/db/skills"
import { SkillResourceManager } from "@/components/skills/skill-resource-manager"
import { SkillValidationSection } from "@/components/skills/skill-validation-section"
import type { Skill } from "@/lib/claude/types"

interface Props {
  skill: Skill
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Bottom sheet for the mobile Skills surface. 4 tabs: Overview, Edit,
 * Resources, Validation. Edit uses a plain Textarea (no Monaco — keyboard
 * + bundle reasons). Sync UI is intentionally hidden — sync is desktop-only.
 */
export function MobileSkillSheet({ skill, open, onOpenChange }: Props) {
  const t = useTranslations("mobile.skills")
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description ?? "")
  const [content, setContent] = useState(skill.content)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await updateSkill(skill.id, { name, description, content })
      toast.success(t("saved"))
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] p-0">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{skill.name}</SheetTitle>
        </SheetHeader>
        <Tabs defaultValue="overview" className="flex h-full flex-col">
          <TabsList className="mx-4 mt-2">
            <TabsTrigger value="overview">{t("tabOverview")}</TabsTrigger>
            <TabsTrigger value="edit">{t("tabEdit")}</TabsTrigger>
            <TabsTrigger value="resources">{t("tabResources")}</TabsTrigger>
            <TabsTrigger value="validation">{t("tabValidation")}</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex-1 overflow-y-auto px-4 py-3 text-xs">
            <div className="space-y-2">
              <div>
                <span className="text-muted-foreground">{t("metaCategory")}: </span>
                {skill.category ?? "—"}
              </div>
              <div>
                <span className="text-muted-foreground">{t("metaUsage")}: </span>
                {skill.usageCount ?? 0}
              </div>
              <div>
                <span className="text-muted-foreground">{t("metaUpdated")}: </span>
                {new Date(skill.updatedAt).toLocaleString()}
              </div>
            </div>
          </TabsContent>
          <TabsContent value="edit" className="flex-1 overflow-y-auto px-4 py-3">
            <div className="space-y-3">
              <div>
                <Label htmlFor="m-skill-name">{t("name")}</Label>
                <Input id="m-skill-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="m-skill-desc">{t("description")}</Label>
                <Input
                  id="m-skill-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="m-skill-content">{t("content")}</Label>
                <Textarea
                  id="m-skill-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={12}
                />
              </div>
              <Button onClick={() => void save()} disabled={saving} className="w-full">
                {t("save")}
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="resources" className="flex-1 overflow-y-auto px-4 py-3">
            <SkillResourceManager skillId={skill.id} />
          </TabsContent>
          <TabsContent value="validation" className="flex-1 overflow-y-auto px-4 py-3">
            <SkillValidationSection errors={skill.validationErrors ?? []} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
