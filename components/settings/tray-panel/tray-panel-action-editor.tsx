"use client"

/**
 * Dialog for authoring one tray-panel action: its label, when it is offered
 * (`trigger` + `when`), what it does (`effect`), and the input fields the
 * effect's `{{placeholders}}` read.
 *
 * Save is gated on `validateActionDraft`, so a malformed action can never
 * reach the panel — the panel has no room to explain a broken entry, and a
 * silently-inert row in a popover is indistinguishable from a bug.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { NATIVE_TRAY_ACTIONS } from "@/lib/tray/native-actions"
import { validateActionDraft, type TrayPanelDraftIssue } from "@/lib/tray-panel/resolve"
import type {
  TrayPanelAction,
  TrayPanelEffect,
  TrayPanelEffectKind,
  TrayPanelTriggerKind,
} from "@/lib/tray-panel/types"
import type { TrayNativeAction } from "@/lib/tray/types"

import { TrayPanelFieldEditor } from "./tray-panel-field-editor"

const EFFECT_KINDS: TrayPanelEffectKind[] = ["delegate", "slash", "command", "navigate", "native"]
const TRIGGER_KINDS: TrayPanelTriggerKind[] = ["manual", "submit", "open", "hotkey"]

/** A blank custom action, used by the "add" button. */
export function blankAction(id: string): TrayPanelAction {
  return {
    id,
    label: "",
    fields: [],
    trigger: { kind: "manual" },
    effect: { kind: "delegate", prompt: "", target: "newSession", autoSend: true },
  }
}

/** Swap the effect kind, seeding the new kind's required members. */
export function effectOfKind(kind: TrayPanelEffectKind): TrayPanelEffect {
  switch (kind) {
    case "delegate":
      return { kind, prompt: "", target: "newSession", autoSend: true }
    case "slash":
      return { kind, command: "" }
    case "command":
      return { kind, commandId: "" }
    case "navigate":
      return { kind, path: "/" }
    case "native":
      return { kind, action: "show" }
  }
}

export interface TrayPanelActionEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  action: TrayPanelAction
  onSave: (action: TrayPanelAction) => void
}

/**
 * The dialog shell. The form is a separate component keyed by action id so
 * opening a *different* action remounts it and `useState(action)` re-seeds on
 * its own — an effect that copied the prop into state would be a
 * cascading-render (`react-hooks/set-state-in-effect`) and would also clobber
 * an in-progress edit whenever the parent re-rendered.
 */
export function TrayPanelActionEditor({
  open,
  onOpenChange,
  action,
  onSave,
}: TrayPanelActionEditorProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <ActionEditorForm
          key={action.id}
          action={action}
          onSave={(next) => {
            onSave(next)
            onOpenChange(false)
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

interface ActionEditorFormProps {
  action: TrayPanelAction
  onSave: (action: TrayPanelAction) => void
  onCancel: () => void
}

function ActionEditorForm({ action, onSave, onCancel }: ActionEditorFormProps) {
  const t = useTranslations("settings.trayPanel.editor")
  const [draft, setDraft] = useState<TrayPanelAction>(action)

  const issues = useMemo(() => validateActionDraft(draft), [draft])
  const invalidFieldIds = useMemo(
    () =>
      new Set(
        issues
          .filter((i): i is Extract<TrayPanelDraftIssue, { fieldId: string }> => "fieldId" in i)
          .map((i) => i.fieldId)
      ),
    [issues]
  )

  const describeIssue = (issue: TrayPanelDraftIssue): string => {
    switch (issue.kind) {
      case "missingLabel":
        return t("issues.missingLabel")
      case "duplicateFieldId":
        return t("issues.duplicateFieldId", { id: issue.fieldId })
      case "invalidFieldId":
        return t("issues.invalidFieldId", { id: issue.fieldId })
      case "unknownPlaceholder":
        return t("issues.unknownPlaceholder", { ids: issue.ids.join(", ") })
      case "emptyEffect":
        return t("issues.emptyEffect")
      case "illegalTrigger":
        return t("issues.illegalTrigger")
      case "missingChord":
        return t("issues.missingChord")
      case "emptySelect":
        return t("issues.emptySelect", { id: issue.fieldId })
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <ScrollArea className="max-h-[60vh] pr-3">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tp-label">{t("label")}</Label>
            <Input
              id="tp-label"
              value={draft.label}
              onChange={(e) =>
                // Editing a built-in's label makes the entry user-owned:
                // keeping `labelKey` would make the translation win and the
                // edit look like it never saved.
                setDraft({ ...draft, label: e.target.value, labelKey: undefined })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tp-icon">{t("icon")}</Label>
            <Input
              id="tp-icon"
              value={draft.icon ?? ""}
              placeholder={t("iconPlaceholder")}
              className="font-mono"
              onChange={(e) => setDraft({ ...draft, icon: e.target.value || undefined })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("trigger")}</Label>
              <Select
                value={draft.trigger.kind}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    trigger:
                      v === "hotkey"
                        ? { kind: "hotkey", chord: "mod+1" }
                        : { kind: v as Exclude<TrayPanelTriggerKind, "hotkey"> },
                  })
                }
              >
                <SelectTrigger aria-label={t("trigger")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`triggers.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {draft.trigger.kind === "hotkey" ? (
              <div className="space-y-1.5">
                <Label htmlFor="tp-chord">{t("chord")}</Label>
                <Input
                  id="tp-chord"
                  value={draft.trigger.chord}
                  placeholder={
                    /* i18n-exempt: literal chord syntax, identical in every locale */ "mod+1"
                  }
                  className="font-mono"
                  onChange={(e) =>
                    setDraft({ ...draft, trigger: { kind: "hotkey", chord: e.target.value } })
                  }
                />
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tp-when">{t("when")}</Label>
            <Input
              id="tp-when"
              value={draft.when ?? ""}
              placeholder={t("whenPlaceholder")}
              className="font-mono"
              onChange={(e) => setDraft({ ...draft, when: e.target.value || undefined })}
            />
            <p className="text-xs text-muted-foreground">{t("whenHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t("effect")}</Label>
            <Select
              value={draft.effect.kind}
              onValueChange={(v) =>
                setDraft({ ...draft, effect: effectOfKind(v as TrayPanelEffectKind) })
              }
            >
              <SelectTrigger aria-label={t("effect")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFECT_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`effects.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {draft.effect.kind === "delegate" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="tp-prompt">{t("prompt")}</Label>
                <Textarea
                  id="tp-prompt"
                  rows={3}
                  value={draft.effect.prompt}
                  placeholder={t("promptPlaceholder")}
                  className="resize-none font-mono text-xs"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      effect: {
                        ...draft.effect,
                        kind: "delegate",
                        prompt: e.target.value,
                      } as TrayPanelEffect,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">{t("promptHint")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tp-target">{t("target")}</Label>
                <Input
                  id="tp-target"
                  value={String(draft.effect.target)}
                  className="font-mono"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      effect: {
                        ...draft.effect,
                        kind: "delegate",
                        target: e.target.value,
                      } as TrayPanelEffect,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">{t("targetHint")}</p>
              </div>
            </>
          ) : null}

          {draft.effect.kind === "slash" ? (
            <div className="space-y-1.5">
              <Label htmlFor="tp-slash">{t("slash")}</Label>
              <Input
                id="tp-slash"
                value={draft.effect.command}
                className="font-mono"
                onChange={(e) =>
                  setDraft({ ...draft, effect: { kind: "slash", command: e.target.value } })
                }
              />
            </div>
          ) : null}

          {draft.effect.kind === "command" ? (
            <div className="space-y-1.5">
              <Label htmlFor="tp-command">{t("commandId")}</Label>
              <Input
                id="tp-command"
                value={draft.effect.commandId}
                className="font-mono"
                onChange={(e) =>
                  setDraft({ ...draft, effect: { kind: "command", commandId: e.target.value } })
                }
              />
            </div>
          ) : null}

          {draft.effect.kind === "navigate" ? (
            <div className="space-y-1.5">
              <Label htmlFor="tp-path">{t("path")}</Label>
              <Input
                id="tp-path"
                value={draft.effect.path}
                className="font-mono"
                onChange={(e) =>
                  setDraft({ ...draft, effect: { kind: "navigate", path: e.target.value } })
                }
              />
            </div>
          ) : null}

          {draft.effect.kind === "native" ? (
            <div className="space-y-1.5">
              <Label>{t("nativeAction")}</Label>
              <Select
                value={draft.effect.action}
                onValueChange={(v) =>
                  setDraft({ ...draft, effect: { kind: "native", action: v as TrayNativeAction } })
                }
              >
                <SelectTrigger aria-label={t("nativeAction")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NATIVE_TRAY_ACTIONS.map((native) => (
                    <SelectItem key={native} value={native}>
                      {native}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="tp-focus">{t("focusMainWindow")}</Label>
            <Switch
              id="tp-focus"
              checked={draft.focusMainWindow ?? false}
              onCheckedChange={(on) => setDraft({ ...draft, focusMainWindow: on })}
            />
          </div>

          <div className="space-y-2 border-t pt-4">
            <div>
              <h4 className="text-sm font-medium">{t("fields")}</h4>
              <p className="text-xs text-muted-foreground">{t("fieldsHint")}</p>
            </div>
            <TrayPanelFieldEditor
              fields={draft.fields}
              invalidIds={invalidFieldIds}
              onChange={(fields) => setDraft({ ...draft, fields })}
            />
          </div>

          {issues.length > 0 ? (
            <ul className="space-y-1 border-t pt-3" role="alert">
              {issues.map((issue, index) => (
                <li key={index} className="text-xs text-destructive">
                  {describeIssue(issue)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </ScrollArea>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button disabled={issues.length > 0} onClick={() => onSave(draft)}>
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
