"use client"

/**
 * Workspace settings → Governance section.
 *
 * Surfaces the full `TeamGovernancePolicy`: plan-approval flags, token
 * budget thresholds, escalation policy, refusal detection. Patches the
 * team config in place via `updateTeamConfig`.
 *
 * The governance fields are intentionally exposed as a single dense Card.
 * Operators tune them rarely — when they do, they want everything in front
 * of them rather than buried in collapsibles.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  AgentTeam,
  AgentTeamConfig,
  TeamBudgetEscalationAction,
  TeamGovernancePolicy,
} from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  clampMaxRevisions,
  DEFAULT_TASK_REVIEW_MAX_REVISIONS,
  MAX_TASK_REVIEW_REVISIONS,
} from "@/lib/ai/agent/team/task-review-policy"
import { markSettingsSaved } from "./settings-save-indicator"
import { ConfirmActionDialog } from "./confirm-action-dialog"

/** Escalation actions that change runtime blocking — require confirmation. */
const DANGEROUS_CRITICAL: ReadonlySet<TeamBudgetEscalationAction> = new Set([
  "pause_for_review",
  "handoff_to_background",
])

export interface GovernanceSectionProps {
  team: AgentTeam
}

const ESCALATION_ACTIONS: ReadonlyArray<TeamBudgetEscalationAction> = [
  "notify",
  "pause_for_review",
  "reduce_concurrency",
  "handoff_to_background",
]

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, value))
}

export function GovernanceSection({ team }: GovernanceSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.governance")
  const tEsc = useTranslations("agentTeamsWorkspace.settings.governance.escalationOption")
  const tConfirm = useTranslations("agentTeamsWorkspace.settings.confirm")
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)
  const [pendingCritical, setPendingCritical] = useState<TeamBudgetEscalationAction | null>(null)

  const policy: TeamGovernancePolicy = useMemo(
    () =>
      team.config.governancePolicy ?? {
        approval: { requirePlanApproval: false, requireDelegationApproval: false },
        budget: {
          tokenBudget: 0,
          warningThreshold: 0.8,
          criticalThreshold: 0.95,
          onCritical: "notify",
        },
        escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
      },
    [team.config.governancePolicy]
  )

  const patchConfig = useCallback(
    (patch: Partial<AgentTeamConfig>) => {
      updateTeamConfig(team.id, { ...team.config, ...patch })
      markSettingsSaved()
    },
    [team.config, team.id, updateTeamConfig]
  )

  const patchPolicy = useCallback(
    (next: TeamGovernancePolicy) => {
      patchConfig({ governancePolicy: next })
    },
    [patchConfig]
  )

  const applyOnCritical = useCallback(
    (action: TeamBudgetEscalationAction) => {
      patchPolicy({ ...policy, budget: { ...policy.budget, onCritical: action } })
    },
    [patchPolicy, policy]
  )

  const handleOnCriticalChange = (v: string) => {
    const action = v as TeamBudgetEscalationAction
    if (DANGEROUS_CRITICAL.has(action)) {
      setPendingCritical(action)
      return
    }
    applyOnCritical(action)
  }

  return (
    <Card className="space-y-4 p-4">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      {/* Approval */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("approval.heading")}</p>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("approval.requirePlanApproval")}</Label>
          <Switch
            checked={policy.approval.requirePlanApproval}
            onCheckedChange={(v) =>
              patchPolicy({
                ...policy,
                approval: { ...policy.approval, requirePlanApproval: v },
              })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("approval.requireDelegationApproval")}</Label>
          <Switch
            checked={policy.approval.requireDelegationApproval}
            onCheckedChange={(v) =>
              patchPolicy({
                ...policy,
                approval: { ...policy.approval, requireDelegationApproval: v },
              })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("approval.requireResultReview")}</Label>
          <Switch
            checked={policy.approval.requireResultReview === true}
            onCheckedChange={(v) =>
              patchPolicy({
                ...policy,
                approval: { ...policy.approval, requireResultReview: v },
              })
            }
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{t("approval.requireResultReviewHint")}</p>

        {/* Blocking lead review (ADR-0071). Sits under Approval because it is
            the automated sibling of requireResultReview — the two compose. */}
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("approval.taskReview")}</Label>
          <Switch
            data-testid="task-review-toggle"
            checked={team.config.taskReview?.enabled === true}
            onCheckedChange={(v) =>
              patchConfig({ taskReview: { ...team.config.taskReview, enabled: v } })
            }
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{t("approval.taskReviewHint")}</p>
        {team.config.taskReview?.enabled === true && (
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{t("approval.taskReviewMaxRevisions")}</Label>
            <Input
              type="number"
              min={0}
              max={MAX_TASK_REVIEW_REVISIONS}
              className="h-7 w-20 text-xs"
              data-testid="task-review-max-revisions"
              defaultValue={
                team.config.taskReview?.maxRevisions ?? DEFAULT_TASK_REVIEW_MAX_REVISIONS
              }
              onBlur={(e) =>
                patchConfig({
                  taskReview: {
                    ...team.config.taskReview,
                    // Same bounds the runtime resolves against — see task-review-policy.
                    maxRevisions: clampMaxRevisions(Number.parseInt(e.target.value, 10)),
                  },
                })
              }
            />
          </div>
        )}
      </div>

      {/* Budget */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("budget.heading")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">{t("budget.tokenBudget")}</Label>
            <Input
              type="number"
              min={0}
              value={policy.budget.tokenBudget}
              onChange={(e) =>
                patchPolicy({
                  ...policy,
                  budget: {
                    ...policy.budget,
                    tokenBudget: Math.max(0, parseInt(e.target.value, 10) || 0),
                  },
                })
              }
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("budget.warningThreshold")}</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={policy.budget.warningThreshold}
              onChange={(e) =>
                patchPolicy({
                  ...policy,
                  budget: {
                    ...policy.budget,
                    warningThreshold: clamp(parseFloat(e.target.value), 0, 1),
                  },
                })
              }
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("budget.criticalThreshold")}</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={policy.budget.criticalThreshold}
              onChange={(e) =>
                patchPolicy({
                  ...policy,
                  budget: {
                    ...policy.budget,
                    criticalThreshold: clamp(parseFloat(e.target.value), 0, 1),
                  },
                })
              }
              className="h-8 text-xs"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("budget.onCritical")}</Label>
          <Select value={policy.budget.onCritical} onValueChange={handleOnCriticalChange}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ESCALATION_ACTIONS.map((action) => (
                <SelectItem key={action} value={action}>
                  {tEsc(action)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Escalation */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("escalation.heading")}</p>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("escalation.allowOperatorPatternOverride")}</Label>
          <Switch
            checked={policy.escalation.allowOperatorPatternOverride}
            onCheckedChange={(v) =>
              patchPolicy({
                ...policy,
                escalation: { ...policy.escalation, allowOperatorPatternOverride: v },
              })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("escalation.pauseOnHighRisk")}</Label>
          <Switch
            checked={policy.escalation.pauseOnHighRisk}
            onCheckedChange={(v) =>
              patchPolicy({
                ...policy,
                escalation: { ...policy.escalation, pauseOnHighRisk: v },
              })
            }
          />
        </div>
      </div>

      {/* Adaptive re-planning (config-level) */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("adaptiveReplan.heading")}</p>
        <p className="text-[11px] text-muted-foreground">{t("adaptiveReplan.description")}</p>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("adaptiveReplan.enabled")}</Label>
          <Switch
            checked={team.config.adaptiveReplan?.enabled === true}
            onCheckedChange={(v) =>
              patchConfig({ adaptiveReplan: { ...team.config.adaptiveReplan, enabled: v } })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("adaptiveReplan.requireApproval")}</Label>
          <Switch
            checked={team.config.adaptiveReplan?.requireApproval === true}
            onCheckedChange={(v) =>
              patchConfig({ adaptiveReplan: { ...team.config.adaptiveReplan, requireApproval: v } })
            }
          />
        </div>
      </div>

      {/* Autonomous progress ledger (stall detection + escalation) */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("progressLedger.heading")}</p>
        <p className="text-[11px] text-muted-foreground">{t("progressLedger.description")}</p>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("progressLedger.enabled")}</Label>
          <Switch
            checked={team.config.progressLedger?.enabled === true}
            onCheckedChange={(v) =>
              patchConfig({ progressLedger: { ...team.config.progressLedger, enabled: v } })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("progressLedger.allowAutonomousConsensus")}</Label>
          <Switch
            checked={team.config.progressLedger?.allowAutonomousConsensus === true}
            disabled={team.config.progressLedger?.enabled !== true}
            onCheckedChange={(v) =>
              patchConfig({
                progressLedger: { ...team.config.progressLedger, allowAutonomousConsensus: v },
              })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("progressLedger.allowAutonomousDelegation")}</Label>
          <Switch
            checked={team.config.progressLedger?.allowAutonomousDelegation === true}
            disabled={team.config.progressLedger?.enabled !== true}
            onCheckedChange={(v) =>
              patchConfig({
                progressLedger: { ...team.config.progressLedger, allowAutonomousDelegation: v },
              })
            }
          />
        </div>
      </div>

      {/* Refusal detection (config-level, not policy-level) */}
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("refusal.heading")}</p>
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("refusal.detect")}</Label>
          <Switch
            checked={team.config.detectRefusal === true}
            onCheckedChange={(v) => patchConfig({ detectRefusal: v })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("refusal.patterns")}</Label>
          <Textarea
            rows={3}
            value={(team.config.refusalPatterns ?? []).join("\n")}
            onChange={(e) =>
              patchConfig({
                refusalPatterns: e.target.value
                  .split("\n")
                  .map((p) => p.trim())
                  .filter(Boolean),
              })
            }
            placeholder={t("refusal.patternsPlaceholder")}
            className="text-xs"
          />
        </div>
      </div>

      <ConfirmActionDialog
        open={pendingCritical !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCritical(null)
        }}
        title={tConfirm("onCritical.title")}
        description={tConfirm("onCritical.description")}
        confirmLabel={tConfirm("confirmLabel")}
        cancelLabel={tConfirm("cancelLabel")}
        tone="warning"
        onConfirm={() => {
          if (pendingCritical) applyOnCritical(pendingCritical)
          setPendingCritical(null)
        }}
      />
    </Card>
  )
}
