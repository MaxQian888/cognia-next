"use client"

/**
 * Structured payload editor for `background-command` tasks.
 *
 * The type has always been creatable from the form and has always fallen
 * through to a raw JSON textarea, so scheduling a command meant knowing the
 * payload's key names by heart. Three fields is not much of an editor, which
 * is exactly why leaving it as hand-written JSON was hard to justify.
 */

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { DirectoryField } from "@/components/settings/common/directory-field"
import type { BackgroundCommandDraft } from "./types"

export interface BackgroundCommandPayloadEditorProps {
  draft: BackgroundCommandDraft
  onDraftChange: (next: BackgroundCommandDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
}

export function BackgroundCommandPayloadEditor({
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "background-command-payload-editor",
}: BackgroundCommandPayloadEditorProps) {
  const t = useTranslations("scheduler")

  function update<K extends keyof BackgroundCommandDraft>(
    key: K,
    value: BackgroundCommandDraft[K]
  ) {
    onDraftChange({ ...draft, [key]: value })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.backgroundCommand.command")} <span className="text-destructive">*</span>
        </Label>
        <Textarea
          value={draft.command}
          onChange={(e) => update("command", e.target.value)}
          placeholder={t("payload.backgroundCommand.commandPlaceholder")}
          disabled={disabled}
          rows={3}
          className={cn("font-mono text-xs", errors?.command && "border-destructive")}
          data-testid={`${testId}-command`}
        />
        {errors?.command && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.command}`)}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("payload.backgroundCommand.commandHelp")}
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.backgroundCommand.cwd")} <span className="text-destructive">*</span>
        </Label>
        {/* The shared field rather than a bare path input: a command resolved
            against a directory that does not exist fails at run time, hours
            after the user typed it, and this one can browse for a real one. */}
        <DirectoryField
          value={draft.cwd}
          onChange={(next) => update("cwd", next)}
          onCommit={(next) => update("cwd", next)}
          ariaLabel={t("payload.backgroundCommand.cwd")}
          browseLabel={t("payload.backgroundCommand.browse")}
          placeholder={t("payload.backgroundCommand.cwdPlaceholder")}
          disabled={disabled}
        />
        {errors?.cwd && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.cwd}`)}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.backgroundCommand.label")}</Label>
        <Input
          value={draft.label ?? ""}
          onChange={(e) => update("label", e.target.value || undefined)}
          placeholder={t("payload.backgroundCommand.labelPlaceholder")}
          disabled={disabled}
          className="h-10"
          data-testid={`${testId}-label`}
        />
      </div>
    </div>
  )
}
