"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { updateSkill } from "@/lib/db/skills"
import { SkillResourceManager } from "@/components/skills/skill-resource-manager"
import { SkillValidationSection } from "@/components/skills/skill-validation-section"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
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
  const reduce = useReducedMotion()

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
          <TabsContent value="overview" className="flex-1 overflow-y-auto px-4 py-3">
            <motion.div
              role="list"
              className="group/item-group flex flex-col"
              initial={reduce ? false : "initial"}
              animate="animate"
              variants={STAGGER_CONTAINER}
            >
              <motion.div variants={STAGGER_CHILD}>
                <Item>
                  <ItemContent>
                    <ItemTitle>{t("metaCategory")}</ItemTitle>
                    <ItemDescription>{skill.category ?? "—"}</ItemDescription>
                  </ItemContent>
                </Item>
              </motion.div>
              <motion.div variants={STAGGER_CHILD}>
                <Item>
                  <ItemContent>
                    <ItemTitle>{t("metaUsage")}</ItemTitle>
                    <ItemDescription>{skill.usageCount ?? 0}</ItemDescription>
                  </ItemContent>
                </Item>
              </motion.div>
              <motion.div variants={STAGGER_CHILD}>
                <Item>
                  <ItemContent>
                    <ItemTitle>{t("metaUpdated")}</ItemTitle>
                    <ItemDescription>{new Date(skill.updatedAt).toLocaleString()}</ItemDescription>
                  </ItemContent>
                </Item>
              </motion.div>
            </motion.div>
          </TabsContent>
          <TabsContent value="edit" className="flex-1 overflow-y-auto px-4 py-3">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="m-skill-name">{t("name")}</FieldLabel>
                <Input id="m-skill-name" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="m-skill-desc">{t("description")}</FieldLabel>
                <Input
                  id="m-skill-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="m-skill-content">{t("content")}</FieldLabel>
                <Textarea
                  id="m-skill-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={12}
                />
              </Field>
              <Button onClick={() => void save()} disabled={saving} className="w-full">
                {t("save")}
              </Button>
            </FieldGroup>
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
