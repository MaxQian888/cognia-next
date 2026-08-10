"use client"

/**
 * Settings → Connections → Labels. Manage the conversation-label catalog
 * (CRM, schema v83): create, recolor, rename, delete. Built-in starter labels
 * are protected from deletion. CRUD goes through lib/db/conversation-labels;
 * the list is reactive via useConversationLabels.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useConversationLabels } from "@/hooks/connectors/use-conversation-labels"
import { createLabel, updateLabel, deleteLabel } from "@/lib/db/conversation-labels"

const DEFAULT_COLOR = "#64748b"

export function LabelsTab() {
  const t = useTranslations("settings.connections.labels")
  const labels = useConversationLabels()
  const [name, setName] = useState("")
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [busy, setBusy] = useState(false)

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error(t("nameRequired"))
      return
    }
    setBusy(true)
    try {
      await createLabel({ name: trimmed, color })
      setName("")
      setColor(DEFAULT_COLOR)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteLabel(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="new-label-name" className="text-xs">
            {t("nameLabel")}
          </Label>
          <Input
            id="new-label-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            disabled={busy}
            className="w-48"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-label-color" className="text-xs">
            {t("colorLabel")}
          </Label>
          <Input
            id="new-label-color"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={busy}
            className="h-9 w-14 p-1"
          />
        </div>
        <Button type="button" size="sm" onClick={handleCreate} disabled={busy}>
          <PlusIcon className="size-3.5" />
          {t("addButton")}
        </Button>
      </div>

      <ul className="divide-y rounded-md border" data-testid="labels-list">
        {labels.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">{t("empty")}</li>
        )}
        {labels.map((l) => (
          <li key={l.id} className="flex items-center gap-2 px-3 py-2">
            <Input
              type="color"
              defaultValue={l.color ?? DEFAULT_COLOR}
              aria-label={t("rowColorAria", { name: l.name })}
              onChange={(e) => {
                void updateLabel(l.id, { color: e.target.value })
              }}
              className="h-6 w-8 shrink-0 cursor-pointer rounded border p-0.5"
            />
            <Input
              defaultValue={l.name}
              aria-label={t("rowNameAria", { name: l.name })}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== l.name) void updateLabel(l.id, { name: v })
              }}
              className="flex-1 truncate rounded bg-transparent px-1 text-sm outline-none focus:bg-muted"
            />
            {l.builtin && (
              <Badge variant="outline" className="text-[10px]">
                {t("builtinBadge")}
              </Badge>
            )}
            {!l.builtin && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => handleDelete(l.id)}
                aria-label={t("deleteAria", { name: l.name })}
                className="size-7"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
