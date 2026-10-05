"use client"

/**
 * Duplicate one external-agent configuration (ADR-0216).
 *
 * A copy used to be made with one click: same settings, a "(copy)" name, and
 * — silently — the source's runtime home, so the two shared a login and a
 * session history the user had no way to see. Making the copy is now a short
 * choice: its name, where it keeps its runtime state (its own folder by
 * default), and whether it starts switched on. What carries over and what
 * does not is said before the copy exists, not discovered afterwards.
 */

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ResponsiveFormDialog } from "@/components/shared/responsive-form-dialog"
import {
  StateIsolationField,
  defaultStateIsolationFor,
  effectiveStateIsolation,
} from "@/components/agent/external-agent/add-agent/state-isolation-field"
import {
  duplicateDroppedEnvKeys,
  uniqueDuplicateName,
  type ExternalAgentDuplicateOptions,
} from "@/lib/ai/agent/external/config/duplicate-config"
import type { ExternalAgentConfig, ExternalAgentStateIsolation } from "@/types/agent/external-agent"

export interface DuplicateAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: ExternalAgentConfig
  /** Every configuration's name, so the suggested one is free. */
  existingNames: readonly string[]
  /** Resolves `true` once the copy exists; the dialog stays open on `false`. */
  onDuplicate: (options: ExternalAgentDuplicateOptions) => Promise<boolean>
}

export function DuplicateAgentDialog({
  open,
  onOpenChange,
  source,
  existingNames,
  onDuplicate,
}: DuplicateAgentDialogProps) {
  const t = useTranslations("externalAgent.duplicateDialog")
  const tSettings = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const ids = useId()
  const command = source.transport === "stdio" ? source.process?.command : undefined
  const args = source.process?.args ?? []

  const [name, setName] = useState(() =>
    uniqueDuplicateName(existingNames, (index) =>
      index === 1
        ? tSettings("duplicateName", { name: source.name })
        : t("numberedName", { name: source.name, index })
    )
  )
  const [isolation, setIsolation] = useState<ExternalAgentStateIsolation>(() =>
    defaultStateIsolationFor(command, args)
  )
  const [enabled, setEnabled] = useState(source.enabled)
  const [submitting, setSubmitting] = useState(false)
  const [nameError, setNameError] = useState(false)

  const droppedEnvKeys = duplicateDroppedEnvKeys(source)
  const effectiveIsolation = effectiveStateIsolation(isolation, command, args)
  const nameTaken = existingNames.some(
    (existing) => existing.trim().toLowerCase() === name.trim().toLowerCase()
  )

  const submit = async () => {
    if (!name.trim()) {
      setNameError(true)
      return
    }
    setSubmitting(true)
    try {
      const ok = await onDuplicate({
        name: name.trim(),
        stateIsolation: effectiveIsolation,
        enabled,
      })
      if (ok) onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ResponsiveFormDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next)
      }}
      title={t("title", { name: source.name })}
      description={t("description")}
      testid="duplicate-agent"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting}
            data-testid="duplicate-agent-submit"
          >
            {submitting ? <Spinner className="mr-1 size-4" /> : null}
            {t("submit")}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-name`}>{t("nameLabel")}</Label>
          <Input
            id={`${ids}-name`}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setNameError(false)
            }}
            aria-invalid={nameError || undefined}
            aria-describedby={`${ids}-name-hint`}
            disabled={submitting}
            data-testid="duplicate-agent-name"
          />
          <p
            id={`${ids}-name-hint`}
            className={nameError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            role={nameError ? "alert" : undefined}
          >
            {nameError ? t("nameRequired") : nameTaken ? t("nameTaken") : t("nameHint")}
          </p>
        </div>

        {source.transport === "stdio" ? (
          <StateIsolationField
            value={isolation}
            onChange={setIsolation}
            command={command}
            args={args}
            disabled={submitting}
          />
        ) : null}

        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <Label htmlFor={`${ids}-enabled`}>{t("enabledLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
          </div>
          <Switch
            id={`${ids}-enabled`}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={submitting}
            data-testid="duplicate-agent-enabled"
          />
        </div>

        <ul className="grid gap-1.5 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <li className="flex items-start gap-1.5">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("carriesOver")}
          </li>
          <li className="flex items-start gap-1.5">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("leftBehind")}
          </li>
          {effectiveIsolation === "isolated" && source.transport === "stdio" ? (
            <li className="flex items-start gap-1.5" data-testid="duplicate-agent-sign-in-note">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("signInAgain")}
            </li>
          ) : null}
          {droppedEnvKeys.length > 0 ? (
            <li className="flex items-start gap-1.5" data-testid="duplicate-agent-dropped-env">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("droppedEnv", { keys: droppedEnvKeys.join(", ") })}
            </li>
          ) : null}
        </ul>
        {/* Enter in the name field submits; the visible buttons live in the footer. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          {t("submit")}
        </button>
      </form>
    </ResponsiveFormDialog>
  )
}
