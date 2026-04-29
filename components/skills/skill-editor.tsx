"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircleIcon, SparklesIcon } from "lucide-react"
import { Streamdown } from "streamdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { SKILL_CATEGORIES } from "@/lib/skills/categories"
import { validateSkill } from "@/lib/skills/validate"
import type { Skill, SkillCategory, SkillValidationError } from "@/lib/claude/types"
import type { SkillDraft } from "@/lib/db/skills"
import { SkillEditorAiPopup } from "./skill-editor-ai-popup"

export type EditorMode = "create" | "edit"

interface Props {
  mode: EditorMode
  initial?: Skill | null
  onCancel: () => void
  onSave: (draft: SkillDraft) => Promise<void>
  /**
   * When set, the AI assist button is enabled. The popup calls this with the
   * intent ("optimize" / "simplify" / etc.) and resolves to the suggested
   * markdown content. Returning null cancels the popup.
   */
  onAiAssist?: (
    intent: "optimize" | "simplify" | "expand" | "fixErrors",
    current: {
      name: string
      description?: string
      content: string
      validationErrors?: SkillValidationError[]
    }
  ) => Promise<string | null>
}

interface FormState {
  name: string
  description: string
  content: string
  category: SkillCategory
  allowedTools: string
  tags: string
  version: string
  author: string
  license: string
}

function emptyState(): FormState {
  return {
    name: "",
    description: "",
    content: "",
    category: "custom",
    allowedTools: "",
    tags: "",
    version: "",
    author: "",
    license: "",
  }
}

function fromSkill(s: Skill): FormState {
  return {
    name: s.name,
    description: s.description ?? "",
    content: s.content,
    category: (s.category as SkillCategory) ?? "custom",
    allowedTools: (s.allowedTools ?? []).join(", "),
    tags: (s.tags ?? []).join(", "),
    version: s.version ?? "",
    author: s.author ?? "",
    license: s.license ?? "",
  }
}

function parseChips(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function SkillEditor({ mode, initial, onCancel, onSave, onAiAssist }: Props) {
  const t = useTranslations("skills.editor")
  const tCommon = useTranslations("skills")
  const [form, setForm] = useState<FormState>(() => (initial ? fromSkill(initial) : emptyState()))
  const [saving, setSaving] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setForm(initial ? fromSkill(initial) : emptyState())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initial])

  const validation: SkillValidationError[] = useMemo(
    () =>
      validateSkill({
        name: form.name,
        description: form.description,
        content: form.content,
      }),
    [form]
  )
  const hasErrors = validation.length > 0
  const fieldErrors = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of validation) {
      if (e.field) map.set(e.field, e.message)
    }
    return map
  }, [validation])

  const submit = async () => {
    if (hasErrors) return
    setSaving(true)
    try {
      const allowed = parseChips(form.allowedTools)
      const tags = parseChips(form.tags)
      await onSave({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        content: form.content,
        allowedTools: allowed.length ? allowed : undefined,
        tags: tags.length ? tags : undefined,
        category: form.category,
        version: form.version.trim() || undefined,
        author: form.author.trim() || undefined,
        license: form.license.trim() || undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("name")} error={fieldErrors.get("name")}>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("namePlaceholder")}
          />
        </Field>
        <Field label={t("category")}>
          <Select
            value={form.category}
            onValueChange={(v) => setForm({ ...form, category: v as SkillCategory })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SKILL_CATEGORIES.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {tCommon(`category.${cat.labelKey}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label={t("description")} error={fieldErrors.get("description")}>
        <Input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder={t("descriptionPlaceholder")}
        />
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label={t("version")}>
          <Input
            value={form.version}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
            placeholder="1.0.0"
          />
        </Field>
        <Field label={t("author")}>
          <Input
            value={form.author}
            onChange={(e) => setForm({ ...form, author: e.target.value })}
          />
        </Field>
        <Field label={t("license")}>
          <Input
            value={form.license}
            onChange={(e) => setForm({ ...form, license: e.target.value })}
            placeholder="MIT"
          />
        </Field>
      </div>

      <Field label={t("tags")}>
        <Input
          value={form.tags}
          onChange={(e) => setForm({ ...form, tags: e.target.value })}
          placeholder={t("tagsPlaceholder")}
        />
      </Field>

      <Field label={t("content")} error={fieldErrors.get("content")} hint={t("contentHint")}>
        <Tabs defaultValue="edit">
          <div className="flex items-center justify-between">
            <TabsList variant="line" className="h-7">
              <TabsTrigger value="edit" className="text-xs">
                {t("tabEdit")}
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-xs">
                {t("tabPreview")}
              </TabsTrigger>
            </TabsList>
            {onAiAssist && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAiOpen(true)}
                disabled={!form.content.trim() && !form.name.trim()}
              >
                <SparklesIcon className="mr-1.5 size-3.5" />
                {tCommon("ai.buttonLabel")}
              </Button>
            )}
          </div>
          <TabsContent value="edit" className="mt-1.5">
            <Textarea
              rows={14}
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className="font-mono text-xs"
              placeholder={t("contentPlaceholder")}
            />
          </TabsContent>
          <TabsContent value="preview" className="mt-1.5">
            <div className="prose prose-sm dark:prose-invert min-h-[300px] max-w-none rounded-md border bg-muted/30 px-3 py-2 text-sm">
              {form.content.trim() ? (
                <Streamdown>{`## ${form.name || "(unnamed skill)"}\n\n${form.content}`}</Streamdown>
              ) : (
                <p className="m-0 text-xs italic text-muted-foreground">
                  {t("contentPlaceholder")}
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </Field>

      <Field label={t("allowedTools")} hint={t("allowedToolsHint")}>
        <Input
          value={form.allowedTools}
          onChange={(e) => setForm({ ...form, allowedTools: e.target.value })}
          placeholder={t("allowedToolsPlaceholder")}
          className="font-mono text-xs"
        />
      </Field>

      {validation.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertCircleIcon className="size-3.5" />
            {t("validation")}
          </p>
          <ul className="ml-5 list-disc space-y-0.5">
            {validation.map((err, i) => (
              <li key={`${err.code}-${i}`}>{err.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button size="sm" onClick={submit} disabled={saving || hasErrors}>
          {saving
            ? mode === "create"
              ? t("creating")
              : t("saving")
            : mode === "create"
              ? t("create")
              : t("save")}
        </Button>
      </div>

      {onAiAssist && aiOpen && (
        <SkillEditorAiPopup
          current={{
            name: form.name,
            description: form.description,
            content: form.content,
          }}
          validationErrors={validation}
          onClose={() => setAiOpen(false)}
          onAccept={(suggested) => {
            setForm((s) => ({ ...s, content: suggested }))
            setAiOpen(false)
          }}
          onAiAssist={onAiAssist}
        />
      )}
    </div>
  )
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {error ? (
        <p className="text-[10px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
