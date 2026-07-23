"use client"

/**
 * ApprovalGateDialog — shared modal for the four ADR-0022 HITL gate variants.
 *
 * One component, four `gateType` values: budget / deadlock / plan / teammate_fix.
 * The component does NOT call approval-bus directly; callers thread approve /
 * reject handlers (see `useApprovalGate`) so the dialog stays presentation-only.
 *
 * v1 gates: budget, deadlock, plan, teammate_fix. PR 6 wires teammate_fix.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"

export type ApprovalGateType =
  "budget" | "deadlock" | "plan" | "teammate_fix" | "replan" | "capability_audit"

/**
 * Maps a `gateType` to its i18n namespace under `agentTeam.approvalGate`.
 * `teammate_fix` uses the camelCase `teammateFix` key (the message catalog is
 * camelCased), so a direct `${gateType}.title` lookup would miss.
 */
const GATE_I18N_KEY: Record<ApprovalGateType, string> = {
  budget: "budget",
  deadlock: "deadlock",
  plan: "plan",
  teammate_fix: "teammateFix",
  replan: "replan",
  capability_audit: "capabilityAudit",
}

export interface ApprovalGateDialogProps {
  open: boolean
  onClose: () => void
  gateType: ApprovalGateType
  /** Scope identifier (display only — caller binds approve/reject). */
  scopeId: string
  body?: string
  onApprove: (payload?: unknown) => void
  onReject: (feedback?: string) => void
  /** For deadlock gate: list of currently-quarantined teammate ids. */
  quarantinedTeammates?: Array<{ id: string; name: string }>
}

export function ApprovalGateDialog(props: ApprovalGateDialogProps): React.ReactElement | null {
  const t = useTranslations("agentTeam.approvalGate")
  const [extraTokens, setExtraTokens] = useState<string>("")
  const [resetAll, setResetAll] = useState<boolean>(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  if (!props.open) return null

  const i18nKey = GATE_I18N_KEY[props.gateType]

  const handleApprove = (): void => {
    switch (props.gateType) {
      case "budget":
        props.onApprove({ extraTokens: Number.parseInt(extraTokens || "0", 10) })
        return
      case "deadlock":
        props.onApprove(resetAll ? { resetAll: true } : { teammateIds: [...selected] })
        return
      case "teammate_fix":
        props.onApprove({ action: "rejoin" })
        return
      case "plan":
      case "replan":
      case "capability_audit":
        // Approve applies the lead's proposed re-plan / runs with the stale
        // capabilities as-is; reject continues the original plan / cancels
        // the run. No edit payload.
        props.onApprove()
        return
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(`${i18nKey}.title`)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">{props.body ?? t(`${i18nKey}.body`)}</p>
          {props.gateType === "budget" && (
            <div className="space-y-2">
              <Label htmlFor="extra-tokens">{t("budget.extraTokensLabel")}</Label>
              <Input
                id="extra-tokens"
                type="number"
                min={0}
                placeholder={t("budget.extraTokensPlaceholder")}
                value={extraTokens}
                onChange={(e) => setExtraTokens(e.target.value)}
              />
            </div>
          )}
          {props.gateType === "deadlock" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="reset-all"
                  checked={resetAll}
                  onCheckedChange={(c) => setResetAll(c === true)}
                />
                <Label htmlFor="reset-all">{t("deadlock.resetAll")}</Label>
              </div>
              {!resetAll && props.quarantinedTeammates && props.quarantinedTeammates.length > 0 && (
                <div className="space-y-1 pl-6">
                  <span className="text-xs font-medium">{t("deadlock.resetSelected")}</span>
                  {props.quarantinedTeammates.map((tm) => (
                    <div key={tm.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`tm-${tm.id}`}
                        checked={selected.has(tm.id)}
                        onCheckedChange={(c) => {
                          const next = new Set(selected)
                          if (c === true) next.add(tm.id)
                          else next.delete(tm.id)
                          setSelected(next)
                        }}
                      />
                      <Label htmlFor={`tm-${tm.id}`}>{tm.name}</Label>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onReject()}>
            {props.gateType === "capability_audit" ? t("capabilityAudit.rejectLabel") : t("reject")}
          </Button>
          <Button onClick={handleApprove}>
            {props.gateType === "capability_audit"
              ? t("capabilityAudit.approveLabel")
              : t("approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
