"use client"

/**
 * A workspace's coordination settings, in the workspace manager (ADR-0204):
 * the project goal, how threads run, the coordinator's limits, the workspace's
 * own spending ceiling and its notification rule.
 *
 * Written through, like the knowledge section beside it, rather than joining
 * the manager's Save draft: each value lives somewhere else. The goal and
 * limits are on the workspace row (`Project.coordinator`), the ceiling is in
 * the cost-budget policy (`costBudget.perProject*`, the one place the send
 * gate reads), and the notification rule is in the notification preferences
 * (`notificationPreferences.perProject`). Text and number fields commit on
 * blur or Enter; toggles and selects commit on change.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { BrainIcon } from "lucide-react"
import { hasNoLeakingPii } from "@cognia/redact"
import type { NotificationLevel, NotificationSourcePref } from "@/types/notifications"
import type {
  Project,
  ProjectCoordinatorConfig,
  ProjectCoordinatorModelChoice,
  ProjectCoordinatorPreferences,
  ProjectThreadExecution,
} from "@/types"
import { ModelSelect } from "@/components/shared/model-select"
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
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import { OptionalNumberInput } from "@/components/settings/common/optional-number-input"
import { useSettingDraft } from "@/hooks/settings/use-setting-draft"
import {
  MAX_CONCURRENT_THREADS_LIMIT,
  MAX_DAILY_THREAD_CAP,
  PROJECT_GOAL_MAX_CHARS,
  resolveCoordinatorConfig,
} from "@/lib/project-coordinator/config"
import { updateCoordinator } from "@/lib/project-coordinator/project-access"
import {
  disableProjectCoordination,
  enableProjectCoordination,
} from "@/lib/project-coordinator/user-actions"
import { resolvePreferences } from "@/lib/notifications/preferences"
import { useSettingsStore } from "@/stores/settings"

export interface WorkspaceCoordinationSectionProps {
  project: Project
}

const THREAD_EXECUTIONS: ProjectThreadExecution[] = ["auto", "managedWorktree", "local"]
const OS_GATES = ["inherit", "warning", "error", "critical"] as const
type OsGate = (typeof OS_GATES)[number]

function positiveOrUndefined(raw: string): number | undefined {
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Set or clear one key of a keyed map; an emptied map is dropped. */
function withKey<V>(
  map: Record<string, V> | undefined,
  key: string,
  value: V | undefined
): Record<string, V> | undefined {
  const next = { ...(map ?? {}) }
  // An absent key and a key holding `undefined` mean the same thing, but only
  // the deletion round-trips cleanly through settings sync.
  if (value === undefined) delete next[key]
  else next[key] = value
  return Object.keys(next).length > 0 ? next : undefined
}

export function WorkspaceCoordinationSection({ project }: WorkspaceCoordinationSectionProps) {
  const t = useTranslations("projectCoordinator.settings")
  const config = resolveCoordinatorConfig(project)

  const toggle = async (on: boolean) => {
    try {
      if (on) await enableProjectCoordination(project.id, t("coordinatorTitle"))
      else disableProjectCoordination(project.id)
    } catch (error) {
      toast.error(
        t("toggleFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    }
  }

  return (
    <section className="flex flex-col gap-4" data-testid="workspace-coordination-section">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(on) => void toggle(on)}
          aria-label={t("enabled")}
          data-testid="workspace-coordination-enabled"
        />
      </div>

      {config.enabled ? <CoordinatorFields project={project} /> : null}
      <BudgetFields projectId={project.id} />
      <NotificationFields projectId={project.id} />

      <Button asChild variant="outline" size="sm" className="self-start">
        <Link
          href={`/memory?workspace=${encodeURIComponent(project.id)}`}
          data-testid="workspace-coordination-memory"
        >
          <BrainIcon aria-hidden className="size-3.5" />
          {t("memoryLink")}
        </Link>
      </Button>
    </section>
  )
}

function CoordinatorFields({ project }: { project: Project }) {
  const t = useTranslations("projectCoordinator.settings")
  const config = resolveCoordinatorConfig(project)
  const patchPreferences = (patch: ProjectCoordinatorPreferences) =>
    updateCoordinator(project.id, { preferences: patch })

  const goal = useSettingDraft(config.goal ?? "", (next) =>
    updateCoordinator(project.id, { goal: next.trim() || undefined })
  )
  // The goal rides every coordinator and thread turn, and the send path refuses
  // a prompt carrying an email, key or token. Caught where it is typed, and
  // held rather than saved, so one pasted address cannot stall the project.
  const goalLeaks = goal.value.trim().length > 0 && !hasNoLeakingPii(goal.value)
  const icon = useSettingDraft(config.icon ?? "", (next) =>
    updateCoordinator(project.id, { icon: next.trim() || undefined })
  )

  return (
    <div className="flex flex-col gap-4" data-testid="workspace-coordination-fields">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-goal" className="text-xs">
          {t("goal")}
        </Label>
        <Textarea
          id="project-goal"
          rows={2}
          maxLength={PROJECT_GOAL_MAX_CHARS}
          placeholder={t("goalPlaceholder")}
          value={goal.value}
          aria-invalid={goalLeaks || undefined}
          onChange={(event) => goal.set(event.target.value)}
          onBlur={() => {
            if (!goalLeaks) goal.commit()
          }}
          data-testid="project-goal"
        />
        {goalLeaks ? (
          <p className="text-xs text-destructive" role="alert" data-testid="project-goal-leak">
            {t("goalLeak")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("goalHint")}</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-icon" className="text-xs">
            {t("icon")}
          </Label>
          <Input
            id="project-icon"
            maxLength={4}
            placeholder="🚀"
            value={icon.value}
            onChange={(event) => icon.set(event.target.value)}
            onBlur={icon.commit}
            onKeyDown={icon.commitOnEnter}
            data-testid="project-icon"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">{t("threadExecution")}</Label>
          <Select
            value={config.threadExecution}
            onValueChange={(value) =>
              updateCoordinator(project.id, { threadExecution: value as ProjectThreadExecution })
            }
          >
            <SelectTrigger aria-label={t("threadExecution")} data-testid="project-thread-execution">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THREAD_EXECUTIONS.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`execution.${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-max-concurrent" className="text-xs">
            {t("maxConcurrentThreads")}
          </Label>
          <OptionalNumberInput
            id="project-max-concurrent"
            min={1}
            max={MAX_CONCURRENT_THREADS_LIMIT}
            step="1"
            inputMode="numeric"
            placeholder={t("noLimit")}
            value={config.preferences.maxConcurrentThreads}
            parse={(raw) => {
              const value = Math.trunc(Number.parseFloat(raw))
              return Number.isFinite(value) && value > 0
                ? Math.min(MAX_CONCURRENT_THREADS_LIMIT, value)
                : undefined
            }}
            onCommit={(maxConcurrentThreads) => patchPreferences({ maxConcurrentThreads })}
            data-testid="project-max-concurrent"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-daily-cap" className="text-xs">
            {t("dailyThreadCap")}
          </Label>
          <ClampedNumberInput
            id="project-daily-cap"
            min={1}
            max={MAX_DAILY_THREAD_CAP}
            integer
            commitWhileTyping={false}
            value={config.preferences.dailyThreadCap}
            onCommit={(dailyThreadCap) => patchPreferences({ dailyThreadCap })}
            data-testid="project-daily-cap"
          />
        </div>
      </div>

      <ModelDefaultsFields project={project} />

      <ToggleRow
        id="project-propose-first"
        label={t("proposeBeforeStart")}
        hint={t("proposeBeforeStartHint")}
        checked={config.preferences.proposeBeforeStart}
        onChange={(proposeBeforeStart) => patchPreferences({ proposeBeforeStart })}
      />
      <ToggleRow
        id="project-auto-fix-pr"
        label={t("autoFixPr")}
        hint={t("autoFixPrHint")}
        checked={config.preferences.autoFixPr}
        onChange={(autoFixPr) => patchPreferences({ autoFixPr })}
      />
    </div>
  )
}

const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const
type EffortChoice = (typeof EFFORTS)[number]
type ModelRole = keyof NonNullable<ProjectCoordinatorConfig["model"]>

/** The model and effort new coordinator and thread conversations start with. */
function ModelDefaultsFields({ project }: { project: Project }) {
  const t = useTranslations("projectCoordinator.settings")
  const config = resolveCoordinatorConfig(project)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel ?? "")
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider ?? "")
  // The same tier names the composer's effort control uses; "off" reads "Auto".
  const tLevels = useTranslations("chat.composer.effort.level")

  const write = (role: ModelRole, choice: ProjectCoordinatorModelChoice | undefined) => {
    const next = { ...config.model }
    if (choice && (choice.modelId || choice.effort)) next[role] = choice
    else delete next[role]
    updateCoordinator(project.id, { model: next })
  }

  return (
    <div className="flex flex-col gap-3" data-testid="project-model-defaults">
      <div>
        <p className="text-xs font-medium">{t("models.title")}</p>
        <p className="text-xs text-muted-foreground">{t("models.description")}</p>
      </div>
      {(["coordinator", "threads"] as const).map((role) => {
        const choice = config.model[role]
        return (
          <div
            key={role}
            className="flex flex-wrap items-center gap-2"
            data-testid={`project-model-${role}`}
          >
            <span className="w-24 shrink-0 text-xs text-muted-foreground">
              {t(`models.${role}`)}
            </span>
            <ModelSelect
              model={choice?.modelId ?? defaultModel}
              provider={choice?.providerId ?? defaultProvider}
              onSelect={({ providerId, modelId }) =>
                write(role, { ...choice, modelId, providerId })
              }
              placeholder={t("models.appDefault")}
              className="h-8 min-w-0 flex-1"
            />
            <Select
              value={choice?.effort ?? "default"}
              onValueChange={(value) => {
                const effort = value === "default" ? undefined : (value as EffortChoice)
                const { effort: _previous, ...rest } = choice ?? {}
                write(role, {
                  ...rest,
                  ...(effort ? { effort } : {}),
                } as ProjectCoordinatorModelChoice)
              }}
            >
              <SelectTrigger
                className="h-8 w-28"
                aria-label={t("models.effort", { role: t(`models.${role}`) })}
                data-testid={`project-effort-${role}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORTS.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {tLevels(effort === "default" ? "off" : effort)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {choice?.modelId ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => {
                  const { modelId: _m, providerId: _p, ...rest } = choice
                  write(role, rest)
                }}
                data-testid={`project-model-${role}-reset`}
              >
                {t("models.useDefault")}
              </Button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={id} />
    </div>
  )
}

function BudgetFields({ projectId }: { projectId: string }) {
  const t = useTranslations("projectCoordinator.settings")
  const budget = useSettingsStore((s) => s.settings?.costBudget)
  const save = useSettingsStore((s) => s.save)
  const patch = (field: "perProjectDailyUsd" | "perProjectMonthlyUsd", value: number | undefined) =>
    save({ costBudget: { ...budget, [field]: withKey(budget?.[field], projectId, value) } })

  return (
    <div className="flex flex-col gap-2 border-t pt-4" data-testid="workspace-budget-fields">
      <div>
        <p className="text-sm font-medium">{t("budget.title")}</p>
        <p className="text-xs text-muted-foreground">{t("budget.description")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-budget-daily" className="text-xs">
            {t("budget.daily")}
          </Label>
          <OptionalNumberInput
            id="project-budget-daily"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder={t("noLimit")}
            value={budget?.perProjectDailyUsd?.[projectId]}
            parse={positiveOrUndefined}
            onCommit={(value) => patch("perProjectDailyUsd", value)}
            data-testid="project-budget-daily"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-budget-monthly" className="text-xs">
            {t("budget.monthly")}
          </Label>
          <OptionalNumberInput
            id="project-budget-monthly"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder={t("noLimit")}
            value={budget?.perProjectMonthlyUsd?.[projectId]}
            parse={positiveOrUndefined}
            onCommit={(value) => patch("perProjectMonthlyUsd", value)}
            data-testid="project-budget-monthly"
          />
        </div>
      </div>
    </div>
  )
}

function NotificationFields({ projectId }: { projectId: string }) {
  const t = useTranslations("projectCoordinator.settings")
  const stored = useSettingsStore((s) => s.settings?.notificationPreferences)
  const save = useSettingsStore((s) => s.save)
  const prefs = resolvePreferences(stored)
  const rule = prefs.perProject?.[projectId]
  const muted = rule?.enabled === false
  const osGate: OsGate =
    rule?.minOsLevel && rule.minOsLevel !== "info" && rule.minOsLevel !== "success"
      ? (rule.minOsLevel as OsGate)
      : "inherit"

  const write = (next: Partial<NotificationSourcePref>) => {
    const merged: NotificationSourcePref = { enabled: true, ...rule, ...next }
    // A rule that changes nothing is no rule: drop it rather than store noise.
    const empty = merged.enabled !== false && !merged.minOsLevel && !merged.channels
    if (merged.minOsLevel === undefined) delete merged.minOsLevel
    return save({
      notificationPreferences: {
        ...prefs,
        perProject: withKey(prefs.perProject, projectId, empty ? undefined : merged),
      },
    })
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-4" data-testid="workspace-notification-fields">
      <p className="text-sm font-medium">{t("notifications.title")}</p>
      <ToggleRow
        id="project-notifications-on"
        label={t("notifications.enabled")}
        hint={t("notifications.enabledHint")}
        checked={!muted}
        onChange={(on) => void write({ enabled: on })}
      />
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">{t("notifications.osGate")}</Label>
        <Select
          value={osGate}
          disabled={muted}
          onValueChange={(value) =>
            void write({
              minOsLevel: value === "inherit" ? undefined : (value as NotificationLevel),
            })
          }
        >
          <SelectTrigger
            aria-label={t("notifications.osGate")}
            data-testid="project-notifications-os-gate"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OS_GATES.map((gate) => (
              <SelectItem key={gate} value={gate}>
                {t(`notifications.gate.${gate}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
