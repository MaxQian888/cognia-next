"use client"

// The template editor — one form for both create and edit.
//
// The parameter declarations collapse behind a disclosure because the body is
// the primary object: the tokens in the text decide WHICH parameters exist;
// the disclosure edits what a token cannot say (label, kind, options). Keeping
// that behind one click is what stopped the old editor's "form wall" — three
// parameters was already a screen of controls before the message itself.
//
// The AI row is assist, not authoring: "generate" drafts the fields for
// review, "improve" rewrites the body in place, "suggest" fills the
// declaration disclosure. Every result lands in the form unsaved — the Save
// button is still the commit point, so a bad generation costs an edit, not a
// template.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, Loader2Icon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  createChatTemplate,
  updateChatTemplate,
  type ChatTemplateRow,
} from "@/lib/db/chat-templates"
import { deriveParams, type ChatTemplateParam } from "@/lib/chat/template/template"
import { useTemplateAssist } from "@/hooks/chat/use-template-assist"
import { TOOLBAR_CHIP } from "@/components/chat/composer/bottom-toolbar"
import { ParamDeclarationRow } from "./param-declaration-row"
import { cn } from "@/lib/utils"

export function ChatTemplateEditor({
  row,
  mobile,
  onCancel,
  onSaved,
}: {
  /** Undefined = create; a row = edit. */
  row?: ChatTemplateRow
  mobile: boolean
  onCancel(): void
  onSaved(row: ChatTemplateRow): void
}) {
  const t = useTranslations("chatTemplatesSettings")
  const [name, setName] = useState(row?.name ?? "")
  const [description, setDescription] = useState(row?.description ?? "")
  const [body, setBody] = useState(row?.body ?? "")
  const [saving, setSaving] = useState(false)
  const [intent, setIntent] = useState("")
  const [paramsOpen, setParamsOpen] = useState(false)
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
  const assist = useTemplateAssist()

  // Shown live so the consequence of editing the body — which parameters this
  // template will ask for — is visible before saving rather than discovered
  // later.
  const params = deriveParams(body, row?.params ?? []).map((param) => edited[param.id] ?? param)

  const patchParam = (id: string, patch: Partial<ChatTemplateParam>) =>
    setEdited((prev) => {
      const base = prev[id] ?? params.find((param) => param.id === id)
      if (!base) return prev
      return { ...prev, [id]: { ...base, ...patch } }
    })

  const notifyAssistError = (kind: "pii-blocked" | "failed", message: string) => {
    if (kind === "pii-blocked") toast.error(t("aiPiiBlocked"))
    else toast.error(t("aiFailed", { error: message }))
  }

  /** True while THIS operation owns the running state — its button is the stop. */
  const isRunning = (op: "generate" | "improve" | "suggest") => assist.running && assist.op === op

  const runGenerate = async () => {
    const res = await assist.generate(intent)
    if (res === null) return
    if (!res.ok) return notifyAssistError(res.kind, res.error)
    setName(res.value.name)
    setDescription(res.value.description ?? "")
    setBody(res.value.body)
    // New tokens mean the old overrides no longer apply — derive fresh.
    setEdited({})
    setParamsOpen(false)
  }

  const runImprove = async () => {
    // The intent box doubles as the improvement instruction — empty means
    // "tighten it up" without a direction.
    const res = await assist.improve(body, intent.trim() || undefined)
    if (res === null) return
    if (!res.ok) return notifyAssistError(res.kind, res.error)
    setBody(res.value)
  }

  const runSuggest = async () => {
    const res = await assist.suggest(body, params)
    if (res === null) return
    if (!res.ok) return notifyAssistError(res.kind, res.error)
    setEdited(Object.fromEntries(res.value.map((param) => [param.id, param])))
    setParamsOpen(true)
  }

  const save = async () => {
    if (!name.trim() || !body.trim() || saving) return
    setSaving(true)
    try {
      const fields = {
        name: name.trim(),
        description: description.trim() || undefined,
        body,
        params,
      }
      const saved = row
        ? await updateChatTemplate(row.id, fields)
        : await createChatTemplate(fields)
      toast.success(t("saved"))
      onSaved(saved ?? (row as ChatTemplateRow))
    } catch {
      // The form keeps its contents — the failure is the toast, not a reset.
      toast.error(t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="chat-template-editor">
      <div className="space-y-1.5">
        <Label htmlFor="tpl-edit-name">{t("name")}</Label>
        <Input id="tpl-edit-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tpl-edit-desc">{t("description")}</Label>
        <Input
          id="tpl-edit-desc"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tpl-edit-body">{t("body")}</Label>
        <Textarea
          id="tpl-edit-body"
          className="min-h-32 font-mono text-xs"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t("bodyPlaceholder")}
        />
      </div>

      {/* AI assist, shaped like the composer: one rounded box — the prompt on
          top, the three operations as toolbar chips underneath, exactly where
          the composer keeps its own actions. The running op's chip becomes the
          stop button. */}
      <div>
        <div
          className={cn(
            "rounded-2xl border border-border/70 bg-background/85 px-3 pb-2 pt-0.5 shadow-sm",
            "transition-[border-color,box-shadow,background-color] duration-200 motion-reduce:transition-none",
            "focus-within:border-primary/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15"
          )}
        >
          <Input
            className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder={t("aiIntentPlaceholder")}
            aria-label={t("aiIntentPlaceholder")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && intent.trim() && !assist.running) void runGenerate()
            }}
          />
          <div className="flex items-center gap-1">
            <SparklesIcon className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
            <Button
              variant="ghost"
              className={TOOLBAR_CHIP}
              disabled={!isRunning("generate") && (!intent.trim() || assist.running)}
              onClick={() => (isRunning("generate") ? assist.cancel() : void runGenerate())}
            >
              {isRunning("generate") ? <Loader2Icon className="size-3 animate-spin" /> : null}
              {isRunning("generate") ? t("cancel") : t("aiGenerate")}
            </Button>
            <Button
              variant="ghost"
              className={TOOLBAR_CHIP}
              disabled={!isRunning("improve") && (!body.trim() || assist.running)}
              onClick={() => (isRunning("improve") ? assist.cancel() : void runImprove())}
            >
              {isRunning("improve") ? <Loader2Icon className="size-3 animate-spin" /> : null}
              {isRunning("improve") ? t("cancel") : t("aiImprove")}
            </Button>
            <Button
              variant="ghost"
              className={TOOLBAR_CHIP}
              disabled={!isRunning("suggest") && (params.length === 0 || assist.running)}
              onClick={() => (isRunning("suggest") ? assist.cancel() : void runSuggest())}
            >
              {isRunning("suggest") ? <Loader2Icon className="size-3 animate-spin" /> : null}
              {isRunning("suggest") ? t("cancel") : t("aiSuggestSlots")}
            </Button>
          </div>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{t("aiAssistHint")}</p>
      </div>

      <Collapsible open={paramsOpen} onOpenChange={setParamsOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", paramsOpen && "rotate-90")}
            />
            {t("customizeParams")}
            {params.length > 0 ? (
              <span className="ml-1 flex flex-wrap gap-1">
                {params.map((param) => (
                  <Badge
                    key={param.id}
                    variant={param.required ? "secondary" : "outline"}
                    className="font-mono text-[11px]"
                  >
                    {param.id}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground/70">· {t("noParameters")}</span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">{t("paramsHint")}</p>
          {params.map((param) => (
            <ParamDeclarationRow
              key={param.id}
              param={param}
              mobile={mobile}
              onPatch={(patch) => patchParam(param.id, patch)}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button disabled={!name.trim() || !body.trim() || saving} onClick={() => void save()}>
          {t("save")}
        </Button>
      </div>
    </div>
  )
}
