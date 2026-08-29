"use client"

/**
 * Mobile character editor (Wave 2.4).
 *
 * Bottom sheet with the minimum fields needed to create or edit a
 * character on a phone screen — name, description, system prompt,
 * default model, avatar emoji, twin binding. Creates and updates use the
 * durable mirror queue. Destructive deletes require an immediate Host approval
 * and only remove the local row after the Host confirms the deletion.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { createCharacter, deleteCharacter, updateCharacter } from "@/lib/db/characters"
import type { CharacterDraft } from "@/lib/db/characters"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { transport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import type { Character } from "@cognia/agent-config-types"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

export interface CharacterDetailSheetProps {
  open: boolean
  /** When provided, the sheet edits this character; otherwise it creates one. */
  character: Character | null
  onOpenChange: (next: boolean) => void
}

interface FormState {
  name: string
  description: string
  systemPrompt: string
  model: string
  avatarEmoji: string
  avatarColor: string
}

const EMPTY: FormState = {
  name: "",
  description: "",
  systemPrompt: "",
  model: "",
  avatarEmoji: "",
  avatarColor: "#6366f1",
}

function fromCharacter(c: Character | null): FormState {
  if (!c) return { ...EMPTY }
  return {
    name: c.name,
    description: c.description ?? "",
    systemPrompt: c.systemPrompt,
    model: c.model ?? "",
    avatarEmoji: c.avatarEmoji ?? "",
    avatarColor: c.avatarColor ?? "#6366f1",
  }
}

export function CharacterDetailSheet({ open, character, onOpenChange }: CharacterDetailSheetProps) {
  const t = useTranslations("mobile.characterEdit")
  const [form, setForm] = useState<FormState>(() => fromCharacter(character))
  const [busy, setBusy] = useState(false)
  useBackDismiss(open, () => onOpenChange(false))

  // Adjust form state when the sheet opens for a different character or
  // flips between create / edit. Following React's "you might not need
  // an Effect" guidance: derive from props at render time via a key
  // tracker rather than syncing through useEffect.
  const [lastKey, setLastKey] = useState<string | null>(open ? (character?.id ?? "new") : null)
  const currentKey = open ? (character?.id ?? "new") : null
  if (currentKey !== lastKey) {
    setLastKey(currentKey)
    if (open) setForm(fromCharacter(character))
  }

  const isEdit = character !== null
  const valid = form.name.trim().length > 0 && form.systemPrompt.trim().length > 0

  const onSave = async () => {
    if (!valid || busy) return
    setBusy(true)
    try {
      const draft: CharacterDraft = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        systemPrompt: form.systemPrompt.trim(),
        model: form.model.trim() || undefined,
        avatarEmoji: form.avatarEmoji || undefined,
        avatarColor: form.avatarColor || undefined,
      }
      if (isEdit && character) {
        await updateCharacter(character.id, draft)
        await enqueue({
          command: "character_upsert",
          payload: { id: character.id, draft },
          label: t("queueLabelUpdate", { name: draft.name }),
        })
      } else {
        const created = await createCharacter(draft)
        await enqueue({
          command: "character_upsert",
          payload: { id: created.id, draft },
          label: t("queueLabelCreate", { name: draft.name }),
        })
      }
      toast.success(isEdit ? t("savedUpdate") : t("savedCreate"))
      onOpenChange(false)
    } catch (err) {
      toast.error(t("saveFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (!isEdit || !character || busy) return
    if (character.isBuiltIn) {
      toast.error(t("cannotDeleteBuiltIn"))
      return
    }
    setBusy(true)
    try {
      const lease = await issueHostAdminLease(["character_delete"])
      await transport.call("character_delete", {
        id: character.id,
        adminLease: lease.token,
      })
      await deleteCharacter(character.id)
      toast.success(t("deleted"))
      onOpenChange(false)
    } catch (err) {
      toast.error(t("deleteFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[90vh] overflow-y-auto"
        data-testid="character-detail-sheet"
      >
        <SheetHeader>
          <SheetTitle>{isEdit ? t("editTitle") : t("createTitle")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4 pt-2">
          <Field
            label={t("nameLabel")}
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            testid="character-name"
          />
          <Field
            label={t("descriptionLabel")}
            value={form.description}
            onChange={(v) => setForm((f) => ({ ...f, description: v }))}
            testid="character-description"
          />
          <Label className="flex flex-col gap-1 text-xs font-medium">
            <span>{t("systemPromptLabel")}</span>
            <Textarea
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
              rows={6}
              data-testid="character-system-prompt"
            />
          </Label>
          <Field
            label={t("defaultModelLabel")}
            value={form.model}
            onChange={(v) => setForm((f) => ({ ...f, model: v }))}
            placeholder="claude-sonnet-4-6"
            testid="character-default-model"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t("avatarEmojiLabel")}
              value={form.avatarEmoji}
              onChange={(v) => setForm((f) => ({ ...f, avatarEmoji: v }))}
              placeholder="🤖"
              testid="character-avatar-emoji"
            />
            <Label className="flex flex-col gap-1 text-xs font-medium">
              <span>{t("avatarColorLabel")}</span>
              <Input
                type="color"
                value={form.avatarColor}
                onChange={(e) => setForm((f) => ({ ...f, avatarColor: e.target.value }))}
                data-testid="character-avatar-color"
              />
            </Label>
          </div>
        </div>
        <SheetFooter className="flex flex-col gap-2 px-4 pb-6">
          <Button
            type="button"
            disabled={!valid || busy}
            onClick={() => void onSave()}
            data-testid="character-save"
          >
            {busy ? t("saving") : isEdit ? t("save") : t("create")}
          </Button>
          {isEdit && !character?.isBuiltIn ? (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void onDelete()}
              data-testid="character-delete"
            >
              <Trash2Icon className="size-4" />
              {t("delete")}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

interface FieldProps {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  testid: string
}

function Field({ label, value, onChange, placeholder, testid }: FieldProps) {
  return (
    <Label className="flex flex-col gap-1 text-xs font-medium">
      <span>{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={testid}
      />
    </Label>
  )
}
