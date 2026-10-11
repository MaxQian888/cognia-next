"use client"

/**
 * Where a new scheduled task, Bot or connection runs (ADR-0224 A5 step 7).
 *
 * `RunsOnField` is the choice a create form shows: the always-on host,
 * chosen by default, or this device. It renders nothing when no always-on
 * host is up, because then there is no choice to make.
 *
 * `PlaceNewItemDialog` runs the move once the item exists here, with the same
 * guided flow the host's device page uses, starting by itself. An item the
 * host cannot take (bound to this machine, a plugin missing there…) stays
 * here, and the dialog says why rather than failing quietly.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  MoveWorkDialog,
  type MoveWorkDialogDeps,
} from "@/components/devices/always-on/move-work-dialog"
import { useMigrationLease } from "@/hooks/remote-host/use-migration-lease"
import type { NewItemPlace, PlaceNewItem } from "@/hooks/remote-host/use-place-new-item"

export function RunsOnField({
  placement,
  idPrefix,
}: {
  placement: PlaceNewItem
  idPrefix: string
}) {
  const t = useTranslations("devices.alwaysOn.place")
  if (!placement.target) return null
  return (
    <div className="space-y-1.5" data-testid="runs-on-field">
      <Label className="text-xs font-medium">{t("label")}</Label>
      <RadioGroup
        value={placement.choice}
        onValueChange={(value) => placement.setChoice(value as NewItemPlace)}
        className="flex flex-wrap gap-4"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="host" id={`${idPrefix}-runs-on-host`} data-testid="runs-on-host" />
          <Label htmlFor={`${idPrefix}-runs-on-host`} className="text-sm font-normal">
            {t("host", { host: placement.target.label })}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="here" id={`${idPrefix}-runs-on-here`} data-testid="runs-on-here" />
          <Label htmlFor={`${idPrefix}-runs-on-here`} className="text-sm font-normal">
            {t("here")}
          </Label>
        </div>
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{t("hint", { host: placement.target.label })}</p>
    </div>
  )
}

export function PlaceNewItemDialog({
  placement,
  onChanged,
  deps,
}: {
  placement: PlaceNewItem
  /** The item moved (or was confirmed to stay): the caller reads again. */
  onChanged?: () => void
  deps?: MoveWorkDialogDeps
}) {
  const lease = useMigrationLease(placement.target?.id ?? null)
  if (!placement.target || !placement.placing) return null
  return (
    <MoveWorkDialog
      open
      onOpenChange={(open) => {
        if (!open) placement.done()
      }}
      hostId={placement.target.id}
      hostLabel={placement.target.label}
      items={[placement.placing]}
      lease={lease}
      onChanged={() => onChanged?.()}
      autoMove
      {...(deps ? { deps } : {})}
    />
  )
}
