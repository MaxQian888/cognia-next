"use client"

/**
 * Add / edit a single `ProfileEntity`. PII-gated via `assertFieldsClean`
 * — same red-line the draft-editor uses, so persona edits cannot smuggle
 * raw email / phone / API key strings into the profile. Manual additions
 * default to `pinned: true` so the next distill run does not erase the
 * user's input.
 */

import { memo, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { assertFieldsClean, DraftPiiError } from "@/lib/twin/distill/draft-pii-guard"
import type { EntityRole, ProfileEntity } from "@/types/twin"

const ROLES: EntityRole[] = ["person", "team", "project", "system", "concept"]

export interface EntityEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, dialog is in edit mode; when null, in add mode. */
  entity: ProfileEntity | null
  onSave: (next: ProfileEntity) => Promise<void> | void
  busy?: boolean
}

interface Form {
  name: string
  role: EntityRole
  aliases: string
  relation: string
}

function toForm(entity: ProfileEntity | null): Form {
  if (!entity) return { name: "", role: "person", aliases: "", relation: "" }
  return {
    name: entity.name,
    role: entity.role,
    aliases: entity.aliases.join(", "),
    relation: entity.relation ?? "",
  }
}

function parseAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export const EntityEditorDialog = memo(function EntityEditorDialog({
  open,
  onOpenChange,
  entity,
  onSave,
  busy = false,
}: EntityEditorDialogProps) {
  const t = useTranslations("twin.persona")
  const initial = useMemo(() => toForm(entity), [entity])
  const [form, setForm] = useState<Form>(initial)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setForm(initial)
      setError(null)
    }
  }, [open, initial])

  const isEdit = entity !== null

  const handleSave = async () => {
    const name = form.name.trim()
    if (!name) {
      setError(t("entity.nameRequired"))
      return
    }
    try {
      assertFieldsClean({
        name,
        description: form.relation,
        aliases: form.aliases,
      })
    } catch (err) {
      if (err instanceof DraftPiiError) {
        setError(t("piiError", { fields: err.violations.map((v) => v.field).join(", ") }))
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    const next: ProfileEntity = {
      name,
      role: form.role,
      aliases: parseAliases(form.aliases),
      relation: form.relation.trim() || undefined,
      firstSeenChunkId: entity?.firstSeenChunkId ?? "manual",
      pinned: isEdit ? entity.pinned : true,
    }
    setError(null)
    try {
      await onSave(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? null : onOpenChange(o))}>
      <DialogContent className="max-w-lg" data-testid="entity-editor-dialog">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("entity.titleEdit") : t("entity.titleAdd")}</DialogTitle>
          <DialogDescription>{t("entity.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="entity-editor-name">{t("entity.nameLabel")}</Label>
            <Input
              id="entity-editor-name"
              data-testid="entity-editor-name"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              disabled={busy}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="entity-editor-role">{t("entity.roleLabel")}</Label>
            <Select
              value={form.role}
              onValueChange={(v) => setForm((p) => ({ ...p, role: v as EntityRole }))}
              disabled={busy}
            >
              <SelectTrigger id="entity-editor-role" data-testid="entity-editor-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`entity.role.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="entity-editor-aliases">{t("entity.aliasesLabel")}</Label>
            <Input
              id="entity-editor-aliases"
              data-testid="entity-editor-aliases"
              placeholder={t("entity.aliasesPlaceholder")}
              value={form.aliases}
              onChange={(e) => setForm((p) => ({ ...p, aliases: e.target.value }))}
              disabled={busy}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="entity-editor-relation">{t("entity.relationLabel")}</Label>
            <Textarea
              id="entity-editor-relation"
              data-testid="entity-editor-relation"
              value={form.relation}
              onChange={(e) => setForm((p) => ({ ...p, relation: e.target.value }))}
              disabled={busy}
              className="min-h-20 text-sm"
            />
          </div>
          {error ? (
            <p className="text-destructive text-sm" data-testid="entity-editor-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("actions.cancel")}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={busy}
            data-testid="entity-editor-save"
          >
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
