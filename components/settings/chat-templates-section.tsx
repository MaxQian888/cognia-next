"use client"

// Manage saved chat templates: rename, rewrite, retire.
//
// This exists because saving one was previously a one-way door — a typo in a
// template body was permanent, and `updateChatTemplate` / `deleteChatTemplate`
// had no caller at all.
//
// Editing the body re-derives the parameter declarations from it, keeping any
// label or requirement someone took the trouble to write (`deriveParams`), and
// bumps the template's revision. Renaming does not: a draft records the
// revision it quoted, so bumping over a cosmetic edit would make every open
// draft claim to be out of date.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { FileCode2Icon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  deleteChatTemplate,
  listChatTemplates,
  updateChatTemplate,
  type ChatTemplateRow,
} from "@/lib/db/chat-templates"
import { deriveParams } from "@/lib/chat/template/template"

export function ChatTemplatesSection() {
  const t = useTranslations("chatTemplatesSettings")
  const [rows, setRows] = useState<ChatTemplateRow[]>([])
  const [epoch, setEpoch] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listChatTemplates()
      .then((next) => {
        if (!cancelled) setRows(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [epoch])

  const reload = useCallback(() => setEpoch((n) => n + 1), [])

  const remove = useCallback(
    async (row: ChatTemplateRow) => {
      await deleteChatTemplate(row.id)
      toast.success(t("deleted", { name: row.name }))
      reload()
    },
    [reload, t]
  )

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">{t("empty")}</CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3" data-testid="chat-templates-section">
      {rows.map((row) =>
        editingId === row.id ? (
          <TemplateEditor
            key={row.id}
            row={row}
            onCancel={() => setEditingId(null)}
            onSaved={() => {
              setEditingId(null)
              reload()
            }}
          />
        ) : (
          <Card key={row.id}>
            <CardHeader className="flex flex-row items-start gap-3 space-y-0">
              <FileCode2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <CardTitle className="text-base">{row.name}</CardTitle>
                {row.description ? (
                  <p className="text-sm text-muted-foreground">{row.description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setEditingId(row.id)}>
                  {t("edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("delete")}
                  onClick={() => void remove(row)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
                {row.body}
              </pre>
              <div className="flex flex-wrap items-center gap-1.5">
                {row.params.map((param) => (
                  <Badge key={param.id} variant="secondary" className="font-mono text-xs">
                    {param.id}
                  </Badge>
                ))}
                {row.launchSpec ? <Badge variant="outline">{t("hasSetup")}</Badge> : null}
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                  {t("used", { count: row.usageCount })}
                </span>
              </div>
            </CardContent>
          </Card>
        )
      )}
    </div>
  )
}

function TemplateEditor({
  row,
  onCancel,
  onSaved,
}: {
  row: ChatTemplateRow
  onCancel(): void
  onSaved(): void
}) {
  const t = useTranslations("chatTemplatesSettings")
  const [name, setName] = useState(row.name)
  const [description, setDescription] = useState(row.description ?? "")
  const [body, setBody] = useState(row.body)
  const [saving, setSaving] = useState(false)
  // Shown live so the consequence of editing the body — which parameters this
  // template will ask for — is visible before saving, not discovered later.
  const params = deriveParams(body, row.params)

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await updateChatTemplate(row.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        body,
      })
      toast.success(t("saved"))
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="chat-template-editor">
      <CardContent className="space-y-3 pt-6">
        <div className="space-y-1.5">
          <Label htmlFor={`tpl-name-${row.id}`}>{t("name")}</Label>
          <Input
            id={`tpl-name-${row.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`tpl-desc-${row.id}`}>{t("description")}</Label>
          <Input
            id={`tpl-desc-${row.id}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`tpl-body-${row.id}`}>{t("body")}</Label>
          <Textarea
            id={`tpl-body-${row.id}`}
            className="min-h-32 font-mono text-xs"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t("parameters")}</span>
          {params.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t("noParameters")}</span>
          ) : (
            params.map((param) => (
              <Badge key={param.id} variant="secondary" className="font-mono text-xs">
                {param.id}
              </Badge>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button disabled={!name.trim() || saving} onClick={() => void save()}>
            {t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
