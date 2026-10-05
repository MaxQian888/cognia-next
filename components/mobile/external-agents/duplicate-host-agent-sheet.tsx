"use client"

/**
 * "Make another like this one" for a Host configuration (ADR-0216).
 *
 * A bottom sheet rather than a centred dialog because it is a form, and on a
 * phone the keyboard covers the middle of the screen. It asks the three things
 * that make a copy a separate configuration rather than a clone: a name that
 * tells the two apart (prefilled with the first free "(copy)" name), where its
 * state lives (its own, by default), and whether it starts enabled. The env
 * keys the copy drops — the ones that would point it at the original's state
 * folder — are named, not silently removed.
 *
 * The Host does the copying (`external_agent_config_duplicate`): the source's
 * secrets are keyring entries on the Host and never come to the phone.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { AlertCircleIcon, InfoIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import {
  StateIsolationField,
  defaultStateIsolationFor,
} from "@/components/agent/external-agent/add-agent/state-isolation-field"
import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import {
  duplicateDroppedEnvKeys,
  uniqueDuplicateName,
} from "@/lib/ai/agent/external/config/duplicate-config"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type {
  ExternalAgentConfig,
  ExternalAgentStateIsolation,
} from "@/types/agent/external-agent"

import { hostAgentName } from "./host-agent-family"

export interface DuplicateHostAgentSheetProps {
  /** The configuration to copy; `null` keeps the sheet closed. */
  record: ExternalAgentConfigRecord | null
  /** Every Host configuration, for picking a free name. */
  records: readonly ExternalAgentConfigRecord[]
  duplicate: HostExternalAgentConfigsState["duplicate"]
  onClose: () => void
  /** The Host created the copy. The caller decides where to go next. */
  onDuplicated: (created: ExternalAgentConfigRecord) => void
}

export function DuplicateHostAgentSheet({
  record,
  records,
  duplicate,
  onClose,
  onDuplicated,
}: DuplicateHostAgentSheetProps) {
  const t = useTranslations("mobile.externalAgents")
  const name = record ? hostAgentName(record) : ""
  return (
    <ResponsiveDetailSheet
      open={record !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t("duplicateTitle", { name })}
      description={t("duplicateDescription")}
    >
      {record ? (
        // Keyed so a second duplicate starts from its own source, not the
        // name and choices typed for the previous one.
        <DuplicateForm
          key={record.configId}
          record={record}
          records={records}
          duplicate={duplicate}
          onCancel={onClose}
          onDuplicated={onDuplicated}
        />
      ) : null}
    </ResponsiveDetailSheet>
  )
}

function DuplicateForm({
  record,
  records,
  duplicate,
  onCancel,
  onDuplicated,
}: {
  record: ExternalAgentConfigRecord
  records: readonly ExternalAgentConfigRecord[]
  duplicate: HostExternalAgentConfigsState["duplicate"]
  onCancel: () => void
  onDuplicated: (created: ExternalAgentConfigRecord) => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const config = record.config as unknown as ExternalAgentConfig
  const sourceName = hostAgentName(record)
  const command = config.process?.command
  const args = config.process?.args ?? []

  const [name, setName] = useState(() =>
    uniqueDuplicateName(
      records.map((row) => row.config.name ?? ""),
      (index) =>
        index === 1
          ? t("copyName", { name: sourceName })
          : t("copyNameNumbered", { name: sourceName, index })
    )
  )
  const [stateIsolation, setStateIsolation] = useState<ExternalAgentStateIsolation>(() =>
    defaultStateIsolationFor(command, args)
  )
  const [enabled, setEnabled] = useState(record.enabled)
  const [problem, setProblem] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const dropped = duplicateDroppedEnvKeys(config)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    const trimmed = name.trim()
    if (!trimmed) {
      setProblem(t("duplicateNameRequired"))
      return
    }
    setProblem(null)
    setSubmitting(true)
    const outcome = await duplicate(record, { name: trimmed, stateIsolation, enabled })
    setSubmitting(false)
    if (!outcome.ok) {
      const message = t("duplicateFailed", { message: outcome.error })
      setProblem(message)
      toast.error(message)
      return
    }
    toast.success(t("duplicated", { name: hostAgentName(outcome.record) }))
    onDuplicated(outcome.record)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-4 overflow-y-auto px-4 pb-4 safe-area-pb"
      noValidate
      data-testid="duplicate-host-agent-form"
    >
      <div className="grid gap-2">
        <Label htmlFor="duplicate-name">{t("duplicateNameLabel")}</Label>
        <Input
          id="duplicate-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-11"
          autoComplete="off"
          required
          data-testid="duplicate-name"
        />
      </div>

      <StateIsolationField
        value={stateIsolation}
        onChange={setStateIsolation}
        command={command}
        args={args}
        disabled={submitting}
      />

      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="duplicate-enabled" className="text-sm">
            {t("duplicateEnabledLabel")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("duplicateEnabledHint")}</p>
        </div>
        <Switch
          id="duplicate-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={submitting}
          data-testid="duplicate-enabled"
        />
      </div>

      {dropped.length > 0 ? (
        <p
          className="flex items-start gap-1.5 text-xs text-muted-foreground"
          data-testid="duplicate-dropped-env"
        >
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("duplicateDroppedEnv", { count: dropped.length, keys: dropped.join(", ") })}
        </p>
      ) : null}

      {problem ? (
        <Alert variant="destructive" data-testid="duplicate-problem">
          <AlertCircleIcon />
          <AlertDescription className="break-words">{problem}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
          {t("duplicateCancel")}
        </Button>
        <Button
          type="submit"
          className="h-11"
          disabled={submitting}
          aria-label={t("duplicateAria", { name: sourceName })}
          data-testid="duplicate-submit"
        >
          {submitting ? (
            <>
              <Spinner className="size-4" />
              {t("duplicating")}
            </>
          ) : (
            t("duplicateSubmit")
          )}
        </Button>
      </div>
    </form>
  )
}
