"use client"

/**
 * SLA escalation policy editor (IM delegation slice 1B). Shared by the inbox
 * override form (per-conversation `escalation`, `undefined` = inherit the
 * adapter default) and the adapter settings card (`defaultEscalation`).
 *
 * Controlled: the parent owns the `EscalationPolicy | undefined` value and
 * persists it. Each step = "minutes overdue" + an action set rendered as
 * chips: notify toggle / reassign target (human · character · team) /
 * switch-mode select / Lark urgent (user open_ids + channel).
 *
 * DORMANCY PIN — the `urgent` action is INTENTIONALLY INERT outside Lark:
 * only the Lark adapter implements `PlatformAdapter.sendUrgent`, so on any
 * other platform the controls render `disabled` with the `urgentLarkOnly`
 * hint (`isUrgentCapablePlatform`), the type doc in
 * `types/connectors/escalation.ts` says so, and
 * `escalation-policy-editor.test.tsx` pins the disabled state.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { EntityPicker } from "@/components/settings/connections/forms/_shared/entity-picker"
import { TeamPicker } from "@/components/settings/connections/forms/_shared/team-picker"
import {
  validateEscalationPolicy,
  type EscalationPolicyIssue,
} from "@/lib/connectors/escalation/policy"
import {
  MAX_ESCALATION_STEPS,
  isUrgentCapablePlatform,
  type EscalationAction,
  type EscalationPolicy,
  type EscalationStep,
} from "@/types/connectors/escalation"
import type { UrgentChannel } from "@/types/connectors/adapter"

export interface EscalationCharacterOption {
  id: string
  name: string
}

export interface EscalationPolicyEditorProps {
  /** `undefined` = inherit (conversation scope) / no policy (adapter scope). */
  value: EscalationPolicy | undefined
  onChange: (next: EscalationPolicy | undefined) => void
  /** Platform of the bot — gates the Lark-only `urgent` action. */
  platform: string | undefined
  /** Conversation scope shows the "override the adapter default" switch. */
  scope: "conversation" | "adapter"
  characters?: readonly EscalationCharacterOption[]
  disabled?: boolean
  /** Prefix for element ids / test ids so two editors can coexist on a page. */
  idPrefix?: string
}

type ReassignKind = "none" | "human" | "character" | "team"
type SwitchModeChoice = "none" | "manual" | "draft"
const URGENT_CHANNELS: readonly UrgentChannel[] = ["app", "sms", "phone"]

function findAction<T extends EscalationAction["type"]>(
  step: EscalationStep,
  type: T
): Extract<EscalationAction, { type: T }> | undefined {
  return step.actions.find((a): a is Extract<EscalationAction, { type: T }> => a.type === type)
}

/** Replace (or remove, when `next` is undefined) the action of `type` on a step, keeping order. */
function withAction(
  step: EscalationStep,
  type: EscalationAction["type"],
  next: EscalationAction | undefined
): EscalationStep {
  const rest = step.actions.filter((a) => a.type !== type)
  if (!next) return { ...step, actions: rest }
  const index = step.actions.findIndex((a) => a.type === type)
  if (index === -1) return { ...step, actions: [...rest, next] }
  const actions = [...step.actions]
  actions[index] = next
  return { ...step, actions }
}

function newStep(previous: EscalationStep | undefined): EscalationStep {
  return {
    afterOverdueMinutes: previous ? previous.afterOverdueMinutes + 15 : 0,
    actions: [{ type: "notify" }],
  }
}

export function EscalationPolicyEditor({
  value,
  onChange,
  platform,
  scope,
  characters = [],
  disabled = false,
  idPrefix = "escalation",
}: EscalationPolicyEditorProps) {
  const t = useTranslations("inbox.conversationOverride.escalation")
  const urgentCapable = isUrgentCapablePlatform(platform)
  const active = value !== undefined
  const steps = value?.steps ?? []
  const validation = value ? validateEscalationPolicy(value) : { ok: true, issues: [] }

  const setSteps = (next: EscalationStep[]): void => onChange({ steps: next })
  const updateStep = (index: number, next: EscalationStep): void =>
    setSteps(steps.map((s, i) => (i === index ? next : s)))

  const issueText = (issue: EscalationPolicyIssue): string => {
    switch (issue.code) {
      case "too_many_steps":
        return t("issues.tooManySteps", { max: issue.max })
      case "step_minutes_invalid":
        return t("issues.stepMinutesInvalid", { step: issue.step + 1 })
      case "steps_not_ascending":
        return t("issues.stepsNotAscending", { step: issue.step + 1 })
      case "step_without_actions":
        return t("issues.stepWithoutActions", { step: issue.step + 1 })
      case "action_type_unknown":
        return t("issues.actionTypeUnknown", { step: issue.step + 1 })
      case "reassign_target_missing":
        return t("issues.reassignTargetMissing", { step: issue.step + 1 })
      case "switch_mode_invalid":
        return t("issues.switchModeInvalid", { step: issue.step + 1 })
      case "urgent_users_missing":
        return t("issues.urgentUsersMissing", { step: issue.step + 1 })
    }
  }

  return (
    <div className="space-y-3" data-testid={`${idPrefix}-editor`}>
      {scope === "conversation" && (
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor={`${idPrefix}-override`} className="cursor-pointer">
                {t("overrideToggle")}
              </Label>
              <Switch
                id={`${idPrefix}-override`}
                checked={active}
                disabled={disabled}
                onCheckedChange={(checked) => onChange(checked ? { steps: [] } : undefined)}
                data-testid={`${idPrefix}-override`}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("overrideHint")}</p>
          </div>
        </div>
      )}

      {active && (
        <div className="space-y-3">
          {steps.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid={`${idPrefix}-empty`}>
              {t("empty")}
            </p>
          )}
          {steps.map((step, index) => {
            const reassign = findAction(step, "reassign")
            const reassignKind: ReassignKind = reassign ? reassign.assignee.kind : "none"
            const switchMode = findAction(step, "switchMode")
            const urgent = findAction(step, "urgent")
            const sid = `${idPrefix}-step-${index}`
            return (
              <div key={index} className="space-y-3 rounded-md border p-3" data-testid={sid}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t("stepLabel", { n: index + 1 })}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={t("removeStep", { n: index + 1 })}
                    data-testid={`${sid}-remove`}
                    onClick={() => setSteps(steps.filter((_, i) => i !== index))}
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`${sid}-minutes`}>{t("afterOverdueMinutes")}</Label>
                  <Input
                    id={`${sid}-minutes`}
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    disabled={disabled}
                    value={String(step.afterOverdueMinutes)}
                    onChange={(e) =>
                      updateStep(index, {
                        ...step,
                        afterOverdueMinutes:
                          e.target.value === "" ? Number.NaN : Number(e.target.value),
                      })
                    }
                    data-testid={`${sid}-minutes`}
                  />
                  <p className="text-xs text-muted-foreground">{t("afterOverdueMinutesHint")}</p>
                </div>

                {/* notify */}
                <div className="flex items-center justify-between">
                  <Label htmlFor={`${sid}-notify`} className="cursor-pointer">
                    {t("actions.notify")}
                  </Label>
                  <Switch
                    id={`${sid}-notify`}
                    disabled={disabled}
                    checked={Boolean(findAction(step, "notify"))}
                    onCheckedChange={(checked) =>
                      updateStep(
                        index,
                        withAction(step, "notify", checked ? { type: "notify" } : undefined)
                      )
                    }
                    data-testid={`${sid}-notify`}
                  />
                </div>

                {/* reassign */}
                <div className="space-y-1.5">
                  <Label htmlFor={`${sid}-reassign`}>{t("actions.reassign")}</Label>
                  <Select
                    value={reassignKind}
                    disabled={disabled}
                    onValueChange={(next) => {
                      const kind = next as ReassignKind
                      if (kind === "none") {
                        updateStep(index, withAction(step, "reassign", undefined))
                        return
                      }
                      updateStep(
                        index,
                        withAction(step, "reassign", {
                          type: "reassign",
                          assignee: kind === "human" ? { kind: "human" } : { kind, id: "" },
                        })
                      )
                    }}
                  >
                    <SelectTrigger id={`${sid}-reassign`} data-testid={`${sid}-reassign`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("actions.reassignNone")}</SelectItem>
                      <SelectItem value="human">{t("actions.reassignHuman")}</SelectItem>
                      <SelectItem value="character">{t("actions.reassignCharacter")}</SelectItem>
                      <SelectItem value="team">{t("actions.reassignTeam")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {reassign?.assignee.kind === "character" && (
                    <EntityPicker
                      id={`${sid}-reassign-character`}
                      value={reassign.assignee.id || undefined}
                      items={characters.map((c) => ({ id: c.id, label: c.name }))}
                      emptyLabel={t("actions.reassignPickCharacter")}
                      missingLabel={(id) => t("actions.referenceMissing", { id })}
                      disabled={disabled}
                      onChange={(id) => {
                        const label = characters.find((c) => c.id === id)?.name
                        updateStep(
                          index,
                          withAction(step, "reassign", {
                            type: "reassign",
                            assignee: { kind: "character", id: id ?? "", label },
                          })
                        )
                      }}
                    />
                  )}
                  {reassign?.assignee.kind === "team" && (
                    <TeamPicker
                      id={`${sid}-reassign-team`}
                      value={reassign.assignee.id || undefined}
                      disabled={disabled}
                      onChange={(teamId) =>
                        updateStep(
                          index,
                          withAction(step, "reassign", {
                            type: "reassign",
                            assignee: { kind: "team", id: teamId ?? "" },
                          })
                        )
                      }
                    />
                  )}
                </div>

                {/* switchMode */}
                <div className="space-y-1.5">
                  <Label htmlFor={`${sid}-switch-mode`}>{t("actions.switchMode")}</Label>
                  <Select
                    value={(switchMode?.mode ?? "none") satisfies SwitchModeChoice}
                    disabled={disabled}
                    onValueChange={(next) => {
                      const mode = next as SwitchModeChoice
                      updateStep(
                        index,
                        withAction(
                          step,
                          "switchMode",
                          mode === "none" ? undefined : { type: "switchMode", mode }
                        )
                      )
                    }}
                  >
                    <SelectTrigger id={`${sid}-switch-mode`} data-testid={`${sid}-switch-mode`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("actions.switchModeNone")}</SelectItem>
                      <SelectItem value="manual">{t("actions.switchModeManual")}</SelectItem>
                      <SelectItem value="draft">{t("actions.switchModeDraft")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* urgent — Lark only; inert (disabled) elsewhere */}
                <div className="space-y-1.5" data-testid={`${sid}-urgent-block`}>
                  <div className="flex items-center justify-between">
                    <Label htmlFor={`${sid}-urgent`} className="cursor-pointer">
                      {t("actions.urgent")}
                    </Label>
                    <Switch
                      id={`${sid}-urgent`}
                      disabled={disabled || !urgentCapable}
                      checked={Boolean(urgent)}
                      onCheckedChange={(checked) =>
                        updateStep(
                          index,
                          withAction(
                            step,
                            "urgent",
                            checked ? { type: "urgent", userIds: [], via: "app" } : undefined
                          )
                        )
                      }
                      data-testid={`${sid}-urgent`}
                    />
                  </div>
                  {!urgentCapable && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid={`${sid}-urgent-lark-only`}
                    >
                      {t("actions.urgentLarkOnly")}
                    </p>
                  )}
                  {urgent && (
                    <div className="space-y-1.5">
                      <Label htmlFor={`${sid}-urgent-users`}>{t("actions.urgentUserIds")}</Label>
                      <Textarea
                        id={`${sid}-urgent-users`}
                        rows={2}
                        disabled={disabled || !urgentCapable}
                        value={urgent.userIds.join("\n")}
                        placeholder={t("actions.urgentUserIdsPlaceholder")}
                        onChange={(e) =>
                          updateStep(
                            index,
                            withAction(step, "urgent", {
                              ...urgent,
                              userIds: e.target.value.split(/[\n,;\s]+/).filter(Boolean),
                            })
                          )
                        }
                        data-testid={`${sid}-urgent-users`}
                      />
                      <Label htmlFor={`${sid}-urgent-via`}>{t("actions.urgentVia")}</Label>
                      <Select
                        value={urgent.via ?? "app"}
                        disabled={disabled || !urgentCapable}
                        onValueChange={(via) =>
                          updateStep(
                            index,
                            withAction(step, "urgent", { ...urgent, via: via as UrgentChannel })
                          )
                        }
                      >
                        <SelectTrigger id={`${sid}-urgent-via`} data-testid={`${sid}-urgent-via`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {URGENT_CHANNELS.map((via) => (
                            <SelectItem key={via} value={via}>
                              {t(`actions.urgentVia_${via}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || steps.length >= MAX_ESCALATION_STEPS}
            onClick={() => setSteps([...steps, newStep(steps.at(-1))])}
            data-testid={`${idPrefix}-add-step`}
          >
            <PlusIcon className="mr-1 size-4" aria-hidden />
            {t("addStep")}
          </Button>
          {steps.length >= MAX_ESCALATION_STEPS && (
            <p className="text-xs text-muted-foreground">
              {t("maxSteps", { max: MAX_ESCALATION_STEPS })}
            </p>
          )}

          {!validation.ok && (
            <ul className="space-y-0.5 text-xs text-destructive" data-testid={`${idPrefix}-issues`}>
              {validation.issues.map((issue, i) => (
                <li key={i}>{issueText(issue)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
