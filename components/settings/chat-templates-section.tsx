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
//
// This is also the only place a parameter's TYPE can be set. The composer
// derives every token as required free text, which is right for a phrase you
// typed once; turning one into a workspace-file reference or a closed list of
// choices is a decision about a template you intend to reuse, and it belongs
// next to the body it describes rather than in a popover you are trying to type
// past.

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
import {
  deriveParams,
  paramKindChange,
  type ChatTemplateParam,
  type ChatTemplateParamKind,
} from "@/lib/chat/template/template"
import { RESOURCE_PARAM_KINDS, type ResourceParamKind } from "@/lib/chat/template/resource-kinds"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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
  /**
   * Declarations edited so far, by id.
   *
   * Kept beside the body rather than in place of it: the BODY decides which
   * parameters exist and in what order (`deriveParams`), and this only carries
   * what a token cannot say about itself. A declaration for a token that has
   * since been deleted simply stops being merged, and comes back if the token
   * does — which is what makes deleting a line and undoing it harmless.
   */
  const [edited, setEdited] = useState<Record<string, ChatTemplateParam>>({})
  // Shown live so the consequence of editing the body — which parameters this
  // template will ask for — is visible before saving, not discovered later.
  const params = deriveParams(body, row.params).map((param) => edited[param.id] ?? param)

  const patchParam = (id: string, patch: Partial<ChatTemplateParam>) =>
    setEdited((prev) => {
      const base = prev[id] ?? params.find((param) => param.id === id)
      if (!base) return prev
      return { ...prev, [id]: { ...base, ...patch } }
    })

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await updateChatTemplate(row.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        body,
        params,
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
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium">{t("parameters")}</span>
            {params.length === 0 ? (
              <span className="text-xs text-muted-foreground">{t("noParameters")}</span>
            ) : null}
          </div>
          {params.length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground">{t("paramsHint")}</p>
              {params.map((param) => (
                <ParamDeclarationRow
                  key={param.id}
                  param={param}
                  onPatch={(patch) => patchParam(param.id, patch)}
                />
              ))}
            </>
          ) : null}
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

/** The declaration controls for one `{{token}}` in the body. */
function ParamDeclarationRow({
  param,
  onPatch,
}: {
  param: ChatTemplateParam
  onPatch(patch: Partial<ChatTemplateParam>): void
}) {
  const t = useTranslations("chatTemplatesSettings")

  return (
    <div className="space-y-2 rounded-md border p-2" data-testid={`param-row-${param.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="shrink-0 font-mono text-xs">
          {param.id}
        </Badge>
        <Input
          className="h-8 min-w-0 flex-1"
          aria-label={t("paramLabel")}
          value={param.label}
          onChange={(event) => onPatch({ label: event.target.value })}
        />
        <Select
          value={param.kind}
          onValueChange={(kind) => onPatch(paramKindChange(param, kind as ChatTemplateParamKind))}
        >
          <SelectTrigger className="h-8 w-32" aria-label={t("paramKind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">{t("kindString")}</SelectItem>
            <SelectItem value="enum">{t("kindEnum")}</SelectItem>
            <SelectItem value="resource">{t("kindResource")}</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
          <Checkbox
            checked={param.required}
            onCheckedChange={(checked) => onPatch({ required: checked === true })}
          />
          {t("paramRequired")}
        </label>
      </div>
      {param.kind === "resource" ? (
        <Select
          value={param.resourceKind ?? "file"}
          onValueChange={(resourceKind) =>
            onPatch({ resourceKind: resourceKind as ResourceParamKind })
          }
        >
          <SelectTrigger className="h-8 w-48" aria-label={t("paramResource")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOURCE_PARAM_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(
                  `resource${kind.charAt(0).toUpperCase()}${kind.slice(1)}` as
                    "resourceFile" | "resourceAgent" | "resourceSubagent"
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : param.kind === "enum" ? (
        <div className="space-y-1">
          <Textarea
            className="min-h-16 text-xs"
            aria-label={t("paramOptions")}
            value={(param.options ?? []).join("\n")}
            onChange={(event) =>
              onPatch({
                options: event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
          <p className="text-xs text-muted-foreground">{t("paramOptionsHint")}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 min-w-0 flex-1"
            aria-label={t("paramDefault")}
            placeholder={t("paramDefault")}
            value={param.defaultValue ?? ""}
            onChange={(event) => onPatch({ defaultValue: event.target.value || undefined })}
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            <Checkbox
              checked={param.multiline === true}
              onCheckedChange={(checked) => onPatch({ multiline: checked === true })}
            />
            {t("paramMultiline")}
          </label>
        </div>
      )}
    </div>
  )
}
