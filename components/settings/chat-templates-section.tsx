"use client"

// Manage saved chat templates: rename, rewrite, duplicate, retire, and move one
// between this machine, a file, and a checkout.
//
// This exists because saving one was previously a one-way door: a typo in a
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
// typed once. Turning one into a workspace-file reference or a closed list of
// choices is a decision about a template you intend to reuse, and it belongs
// next to the body it describes rather than in a popover you are trying to type
// past.
//
// ## Portability
//
// The table is device-local (it has no `lib/sync` handler yet), so the only way
// a template reaches another machine is as a file. Export, import and "save to
// repository" therefore all speak ONE format: the `.cognia/templates/*.md`
// document `parseRepoTemplate` already reads. There is no private export
// dialect, so anything exported here can be committed, reviewed, and read back
// by the composer on somebody else's clone.
//
// Imported and repository-sourced setups go through `demoteRepoLaunchSpec` on
// the way in, exactly like a file found in a checkout. A `.md` the user picked
// off disk arrived from somewhere too, and a permission mode is not something a
// file gets to raise.

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, FileCode2Icon, GitBranchIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { downloadBlob } from "@cognia/plugin-sdk/api/download"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  createChatTemplate,
  deleteChatTemplate,
  listChatTemplates,
  updateChatTemplate,
  type ChatTemplateRow,
} from "@/lib/db/chat-templates"
import {
  deriveParams,
  paramKindChange,
  templateSlug,
  type ChatTemplateParam,
  type ChatTemplateParamKind,
} from "@/lib/chat/template/template"
import { RESOURCE_PARAM_KINDS, type ResourceParamKind } from "@/lib/chat/template/resource-kinds"
import {
  REPO_TEMPLATE_DIR,
  REPO_TEMPLATE_MAX_BYTES,
  parseRepoTemplate,
  serializeChatTemplate,
  type RepoChatTemplate,
} from "@/lib/chat/template/repo-templates"
import { saveChatTemplateToRepository } from "@/lib/chat/template/repo-template-write"
import { loadRepoChatTemplates } from "@/hooks/chat/use-repo-chat-templates"
import { ChatTemplateShareButton } from "@/components/share/chat-template-share-button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export interface ChatTemplatesSectionProps {
  /** When true, switch to the single-column mobile layout. */
  mobile?: boolean
}

/**
 * Which directory "save to repository" writes into.
 *
 * The same chain a send resolves (`resolveEffectiveCwdForSession`), asked with
 * no session: active workspace primary root, then the app default. Imported
 * dynamically so a settings panel does not pull the execution-context and
 * character resolvers into its static graph, and so a build where that chain
 * cannot resolve degrades to "no repository" instead of a blank section.
 */
async function resolveWorkspaceRoot(): Promise<string | null> {
  const { resolveEffectiveCwdForSession } = await import("@/hooks/chat/use-effective-cwd")
  return resolveEffectiveCwdForSession(null)
}

/**
 * Read a picked file as text.
 *
 * `FileReader` rather than `Blob.text()`: the three shells this ships in are
 * three different webviews, and this is the reader every one of them has had
 * for a decade. It is also the one jsdom implements, so the import path is
 * exercised by a test rather than only in a browser.
 */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"))
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.readAsText(file)
  })
}

export function ChatTemplatesSection({ mobile = false }: ChatTemplatesSectionProps) {
  const t = useTranslations("chatTemplatesSettings")
  const [rows, setRows] = useState<ChatTemplateRow[]>([])
  const [repoRows, setRepoRows] = useState<RepoChatTemplate[]>([])
  const [root, setRoot] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** The write that is waiting on "yes, replace the file that is already there". */
  const [overwriting, setOverwriting] = useState<{ row: ChatTemplateRow; path: string } | null>(
    null
  )
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    let cancelled = false
    resolveWorkspaceRoot()
      .then((next) => {
        if (!cancelled) setRoot(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Repository templates are read under the same Workspace Trust verdict the
  // composer applies, by the same loader. An untrusted checkout contributes
  // nothing here either.
  useEffect(() => {
    let cancelled = false
    loadRepoChatTemplates(root)
      .then((next) => {
        if (!cancelled) setRepoRows(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [root, epoch])

  const reload = useCallback(() => setEpoch((n) => n + 1), [])

  const remove = useCallback(
    async (row: ChatTemplateRow) => {
      await deleteChatTemplate(row.id)
      toast.success(t("deleted", { name: row.name }))
      reload()
    },
    [reload, t]
  )

  const duplicate = useCallback(
    async (row: ChatTemplateRow) => {
      // A copy is a NEW template, not a revision of the old one: fresh id, no
      // usage history, and the revision counter back at its baseline, so a
      // draft holding the original's revision is not accidentally satisfied by
      // the copy.
      await createChatTemplate({
        name: t("duplicatedName", { name: row.name }),
        ...(row.description ? { description: row.description } : {}),
        body: row.body,
        params: row.params,
        ...(row.launchSpec ? { launchSpec: row.launchSpec } : {}),
      })
      toast.success(t("duplicated", { name: row.name }))
      reload()
    },
    [reload, t]
  )

  const exportOne = useCallback((row: ChatTemplateRow) => {
    downloadBlob(
      `${templateSlug(row.name)}.md`,
      new Blob([serializeChatTemplate(row)], { type: "text/markdown" })
    )
  }, [])

  const importFile = useCallback(
    async (file: File) => {
      const text = (await readFileText(file)).slice(0, REPO_TEMPLATE_MAX_BYTES)
      const parsed = parseRepoTemplate(file.name, text)
      if (!parsed) {
        toast.error(t("importFailed"))
        return
      }
      // `createChatTemplate` mints the id. The `repo:`-prefixed one the parser
      // produced names a FILE, and reusing it would collide with the checkout's
      // own template the moment one is opened.
      await createChatTemplate({
        name: parsed.name,
        ...(parsed.description ? { description: parsed.description } : {}),
        body: parsed.body,
        params: parsed.params,
        ...(parsed.launchSpec ? { launchSpec: parsed.launchSpec } : {}),
      })
      toast.success(t("imported", { name: parsed.name }))
      reload()
    },
    [reload, t]
  )

  const saveToRepo = useCallback(
    async (row: ChatTemplateRow, overwrite = false) => {
      const outcome = await saveChatTemplateToRepository(root, row, { overwrite })
      if (outcome.ok) {
        toast.success(t("savedToRepo", { path: outcome.path }))
        setOverwriting(null)
        reload()
        return
      }
      if (outcome.reason === "exists") {
        setOverwriting({ row, path: outcome.path })
        return
      }
      setOverwriting(null)
      toast.error(
        outcome.reason === "restricted"
          ? t("saveToRepoRestricted")
          : outcome.reason === "no-root"
            ? t("saveToRepoNoRoot")
            : t("saveToRepoFailed", { path: outcome.path })
      )
    },
    [reload, root, t]
  )

  const adopt = useCallback(
    async (row: RepoChatTemplate) => {
      // The launch spec was already demoted on the way out of the file, and the
      // demoted one is what gets copied. Adopting a repository template must
      // not be a way to launder a setup the trust gate refused.
      await createChatTemplate({
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        body: row.body,
        params: row.params,
        ...(row.launchSpec ? { launchSpec: row.launchSpec } : {}),
      })
      toast.success(t("adopted", { name: row.name }))
      reload()
    },
    [reload, t]
  )

  return (
    <div className="space-y-3" data-testid="chat-templates-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("importHint")}</p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => fileInputRef.current?.click()}
        >
          {t("importAction")}
        </Button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.mdx,text/markdown"
        className="hidden"
        aria-label={t("importAction")}
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Cleared so picking the SAME file twice fires a change event the
          // second time. Without it a failed import cannot be retried.
          event.target.value = ""
          if (file) void importFile(file)
        }}
      />

      {rows.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">{t("empty")}</CardContent>
        </Card>
      ) : (
        rows.map((row) =>
          editingId === row.id ? (
            <TemplateEditor
              key={row.id}
              row={row}
              mobile={mobile}
              onCancel={() => setEditingId(null)}
              onSaved={() => {
                setEditingId(null)
                reload()
              }}
            />
          ) : (
            <Card key={row.id}>
              <CardHeader
                className={cn(
                  "flex gap-3 space-y-0",
                  mobile ? "flex-col items-stretch" : "flex-row items-start"
                )}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <FileCode2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base">{row.name}</CardTitle>
                    {row.description ? (
                      <p className="text-sm text-muted-foreground">{row.description}</p>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => setEditingId(row.id)}>
                    {t("edit")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void duplicate(row)}>
                    {t("duplicate")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => exportOne(row)}>
                    <DownloadIcon className="size-3.5" />
                    {t("exportAction")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void saveToRepo(row)}>
                    <GitBranchIcon className="size-3.5" />
                    {t("saveToRepo")}
                  </Button>
                  {/* The third destination. A file crosses to a machine you can
                      reach, a checkout crosses to a team that has the clone, a
                      link crosses to anyone. The launch spec is demoted before
                      it goes, for the same reason a checkout's is demoted on
                      the way in. */}
                  <ChatTemplateShareButton template={row} />
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
        )
      )}

      <RepoTemplateList mobile={mobile} rows={repoRows} onAdopt={(row) => void adopt(row)} />

      {/*
        Where repository templates live, said out loud. A settings page that
        appeared to OWN them would be lying about where an edit goes: they are
        files, edited with the editor and reviewed in a pull request.
      */}
      <p className="px-1 text-xs text-muted-foreground">
        {t("repoHint", { path: REPO_TEMPLATE_DIR + "/*.md" })}
      </p>

      <AlertDialog
        open={overwriting !== null}
        onOpenChange={(open) => !open && setOverwriting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("overwriteTitle", { path: overwriting?.path ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("overwriteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (overwriting) void saveToRepo(overwriting.row, true)
              }}
            >
              {t("overwriteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The checkout's own templates, listed read-only.
 *
 * They were previously not shown at all, on the grounds that a settings page
 * cannot own a file. That is still true, and nothing here edits one: the single
 * action is to take a COPY into the local table, which is a write to the local
 * table and not to the repository. Seeing them is what makes the copy possible,
 * and what stops "why is this template in my picker" from being unanswerable.
 */
function RepoTemplateList({
  mobile,
  rows,
  onAdopt,
}: {
  mobile: boolean
  rows: readonly RepoChatTemplate[]
  onAdopt(row: RepoChatTemplate): void
}) {
  const t = useTranslations("chatTemplatesSettings")
  if (rows.length === 0) return null
  return (
    <div className="space-y-2" data-testid="repo-chat-templates">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">{t("repoHeading")}</h3>
      {rows.map((row) => (
        <Card key={row.id}>
          <CardHeader
            className={cn(
              "flex gap-3 space-y-0",
              mobile ? "flex-col items-stretch" : "flex-row items-start"
            )}
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <GitBranchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <CardTitle className="text-base">{row.name}</CardTitle>
                <p className="truncate font-mono text-xs text-muted-foreground">{row.sourcePath}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant="outline">{t("repoReadOnly")}</Badge>
              <Button variant="outline" size="sm" onClick={() => onAdopt(row)}>
                {t("adopt")}
              </Button>
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

function TemplateEditor({
  row,
  mobile,
  onCancel,
  onSaved,
}: {
  row: ChatTemplateRow
  mobile: boolean
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
   * does, which is what makes deleting a line and undoing it harmless.
   */
  const [edited, setEdited] = useState<Record<string, ChatTemplateParam>>({})
  // Shown live so the consequence of editing the body, which parameters this
  // template will ask for, is visible before saving rather than discovered
  // later.
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
                  mobile={mobile}
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
  mobile,
  onPatch,
}: {
  param: ChatTemplateParam
  mobile: boolean
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
          className={cn("h-8 min-w-0", mobile ? "w-full" : "flex-1")}
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
          <SelectTrigger
            className={cn("h-8", mobile ? "w-full" : "w-48")}
            aria-label={t("paramResource")}
          >
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
            className={cn("h-8 min-w-0", mobile ? "w-full" : "flex-1")}
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
