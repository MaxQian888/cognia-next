"use client"

// Turn what is already in the composer into a saved template.
//
// The body is not editable here on purpose. You are looking at the message you
// just wrote; re-presenting it in a second, smaller box invites you to edit a
// copy while the real one sits behind the dialog. Name it, describe it, save —
// editing the body means editing the message and saving again.
//
// Parameters are not asked about either. Every `{{token}}` already in the body
// becomes a required parameter labelled by its own id (`deriveParams`), which
// is right often enough that a form here would mostly be dismissed.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { deriveParams } from "@/lib/chat/template/template"
import { hasLaunchSpec, type ChatTemplateLaunchSpec } from "@/lib/chat/template/launch-spec"

export interface SaveAsTemplateDialogProps {
  open: boolean
  /** The composer's current text — what will be saved as the body. */
  body: string
  /**
   * The current conversation's agent / team / repository / model, offered as
   * something the template can remember.
   *
   * Opt-out rather than opt-in: "run this with the reviewer, in this repo" is
   * usually the whole reason a message is worth keeping. It stays safe because
   * a launch spec never applies itself — inserting the template elsewhere
   * offers to start a new conversation, it does not re-point the current one.
   */
  launchSpec?: ChatTemplateLaunchSpec
  /** Human-readable summary of what `launchSpec` would pin, for the checkbox. */
  launchSpecSummary?: string
  onOpenChange(open: boolean): void
  onSave(input: {
    name: string
    description?: string
    launchSpec?: ChatTemplateLaunchSpec
  }): Promise<void>
}

export function SaveAsTemplateDialog({
  open,
  body,
  launchSpec,
  launchSpecSummary,
  onOpenChange,
  onSave,
}: SaveAsTemplateDialogProps) {
  const t = useTranslations("chat.composer.saveTemplate")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [rememberSetup, setRememberSetup] = useState(true)
  const [saving, setSaving] = useState(false)
  const params = deriveParams(body)
  const canRememberSetup = hasLaunchSpec(launchSpec)

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await onSave({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(canRememberSetup && rememberSetup && launchSpec ? { launchSpec } : {}),
      })
      setName("")
      setDescription("")
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="save-as-template-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {params.length > 0
              ? t("descriptionWithParams", {
                  count: params.length,
                  names: params.map((param) => param.id).join(", "),
                })
              : t("description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="save-template-name">{t("name")}</Label>
            <Input
              id="save-template-name"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void save()
                }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="save-template-description">{t("templateDescription")}</Label>
            <Input
              id="save-template-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {canRememberSetup ? (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={rememberSetup}
                onCheckedChange={(next) => setRememberSetup(next === true)}
                data-testid="save-template-remember-setup"
              />
              <span className="flex flex-col gap-0.5">
                <span>{t("rememberSetup")}</span>
                {launchSpecSummary ? (
                  <span className="text-xs text-muted-foreground">{launchSpecSummary}</span>
                ) : null}
              </span>
            </label>
          ) : null}
          {/* The body, shown but not editable — see the note at the top. */}
          <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
            {body}
          </pre>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button disabled={!name.trim() || saving} onClick={() => void save()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
