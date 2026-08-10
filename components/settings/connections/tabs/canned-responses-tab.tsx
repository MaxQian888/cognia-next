"use client"

/**
 * Settings → Connections → Canned Responses. Manage the saved-reply library
 * (CRM, schema v83): create, edit title/body, delete. Built-in starters are
 * protected from deletion. Bodies support {{variable}} interpolation resolved
 * at insert time (see lib/connectors/canned-interpolate). CRUD goes through
 * lib/db/canned-responses; the list is reactive via useCannedResponses.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useCannedResponses } from "@/hooks/connectors/use-canned-responses"
import { createCanned, updateCanned, deleteCanned } from "@/lib/db/canned-responses"

export function CannedResponsesTab() {
  const t = useTranslations("settings.connections.cannedResponses")
  const rows = useCannedResponses()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)

  const handleCreate = async () => {
    const tt = title.trim()
    const bb = body.trim()
    if (!tt || !bb) {
      toast.error(t("titleBodyRequired"))
      return
    }
    setBusy(true)
    try {
      await createCanned({ title: tt, body: bb })
      setTitle("")
      setBody("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteCanned(id)
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

      <div className="space-y-2 rounded-md border p-3">
        <div className="space-y-1">
          <Label htmlFor="new-canned-title" className="text-xs">
            {t("titleLabel")}
          </Label>
          <Input
            id="new-canned-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-canned-body" className="text-xs">
            {t("bodyLabel")}
          </Label>
          <Textarea
            id="new-canned-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("bodyPlaceholder")}
            disabled={busy}
            rows={2}
          />
        </div>
        <Button type="button" size="sm" onClick={handleCreate} disabled={busy}>
          <PlusIcon className="size-3.5" />
          {t("addButton")}
        </Button>
      </div>

      <ul className="divide-y rounded-md border" data-testid="canned-list">
        {rows.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">{t("empty")}</li>
        )}
        {rows.map((c) => (
          <li key={c.id} className="space-y-1 px-3 py-2">
            <div className="flex items-center gap-2">
              <Input
                defaultValue={c.title}
                aria-label={t("rowTitleAria", { title: c.title })}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== c.title) void updateCanned(c.id, { title: v })
                }}
                className="h-auto flex-1 truncate border-0 bg-transparent px-1 py-0 text-sm font-medium shadow-none focus-visible:ring-0"
              />
              {c.isBuiltIn && (
                <Badge variant="outline" className="text-[10px]">
                  {t("builtinBadge")}
                </Badge>
              )}
              {!c.isBuiltIn && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => handleDelete(c.id)}
                  aria-label={t("deleteAria", { title: c.title })}
                  className="size-7"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              )}
            </div>
            <Textarea
              defaultValue={c.body}
              aria-label={t("rowBodyAria", { title: c.title })}
              onBlur={(e) => {
                const v = e.target.value
                if (v && v !== c.body) void updateCanned(c.id, { body: v })
              }}
              rows={2}
              className="min-h-0 w-full resize-y border-0 bg-transparent px-1 py-0 text-xs text-muted-foreground shadow-none focus-visible:ring-0"
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
