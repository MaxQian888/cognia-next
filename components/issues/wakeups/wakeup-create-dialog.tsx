"use client"

/**
 * Add a wakeup to an issue — the person-facing twin of `issue.wakeup_create`.
 *
 * Offers the trigger families as presets rather than the raw match vocabulary:
 * a person thinks "when someone comments" or "every morning", not "event kinds
 * × actor kinds". The form compiles to the same `IssueWakeupSpec` the skill
 * writes, through the same `createIssueWakeup`, so a rule looks the same
 * whoever wrote it.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlarmClockIcon } from "lucide-react"
import { toast } from "sonner"

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  ISSUE_WAKEUP_DEFAULT_MAX_FIRES,
  ISSUE_WAKEUP_INSTRUCTION_MAX,
  ISSUE_WAKEUP_MAX_FIRES_LIMIT,
  WAKEUP_EXPIRY_HOURS,
  WAKEUP_PRESETS,
  isTerminalIssueStatus,
  type WakeupPreset,
  type IssueWakeupSpec,
  type IssueWakeupTriggerSpec,
} from "@/lib/issues/wakeups/model"
import { createIssueWakeup, IssueWakeupWriteError } from "@/lib/issues/wakeups/service"
import { ISSUE_STAGE_MAX, ISSUE_STATUSES, isIssueStage, type IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface WakeupFormState {
  preset: WakeupPreset
  instruction: string
  peopleOnly: boolean
  once: boolean
  toStatus: IssueStatus
  targetIssueId: string
  /** Children-done: the sub-issue stage to wait for, `""` for every sub-issue. */
  stage: string
  /** `HH:MM`, local time. */
  dailyAt: string
  intervalHours: number
  /** `datetime-local` value. */
  at: string
  maxFires: number
  /** Deadline as hours from now, one of {@link WAKEUP_EXPIRY_HOURS}; `""` for none. */
  expiresInHours: string
  /** At the deadline: wake the issue once more instead of just stopping. */
  wakeOnTimeout: boolean
}

export const INITIAL_WAKEUP_FORM: WakeupFormState = {
  preset: "comment",
  instruction: "",
  peopleOnly: true,
  once: false,
  toStatus: "in_review",
  targetIssueId: "",
  stage: "",
  dailyAt: "09:00",
  intervalHours: 4,
  at: "",
  maxFires: ISSUE_WAKEUP_DEFAULT_MAX_FIRES,
  expiresInHours: "",
  wakeOnTimeout: false,
}

/** Presets whose rule can be one-shot or repeat, so the form offers the switch. */
const ONCE_CAPABLE: ReadonlySet<WakeupPreset> = new Set(["comment", "status"])

/**
 * Form → trigger spec, or `null` when a required field is missing. Pure, so
 * the dialog's enabled state and the tests agree on what is submittable.
 */
export function wakeupTriggerFromForm(form: WakeupFormState): IssueWakeupTriggerSpec | null {
  switch (form.preset) {
    case "comment":
      return {
        on: "event",
        kinds: ["commented"],
        ...(form.peopleOnly ? { actorKinds: ["human"] } : {}),
      }
    case "status":
      return { on: "event", kinds: ["status_changed"], toStatuses: [form.toStatus] }
    case "children-done": {
      if (form.stage.trim() === "") return { on: "children-done" }
      const stage = Number(form.stage)
      return isIssueStage(stage) ? { on: "children-done", stage } : null
    }
    case "issue-finished":
      return form.targetIssueId ? { on: "issue-finished", targetIssueId: form.targetIssueId } : null
    case "pr-merged":
      return { on: "pr-merged" }
    case "daily": {
      const match = /^(\d{1,2}):(\d{2})$/.exec(form.dailyAt)
      if (!match) return null
      const hour = Number(match[1])
      const minute = Number(match[2])
      if (hour > 23 || minute > 59) return null
      return {
        on: "cron",
        cronExpression: `${minute} ${hour} * * *`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }
    }
    case "interval":
      return Number.isFinite(form.intervalHours) && form.intervalHours >= 1
        ? { on: "interval", intervalMs: Math.round(form.intervalHours) * 3_600_000 }
        : null
    case "at": {
      const at = form.at ? new Date(form.at) : null
      return at && !Number.isNaN(at.getTime()) ? { on: "at", runAt: at } : null
    }
  }
}

/**
 * Form → the full spec `createIssueWakeup` takes, or `null` when incomplete.
 * `now` anchors the deadline, so the submit and the tests pass the instant.
 */
export function wakeupSpecFromForm(
  issueId: string,
  form: WakeupFormState,
  now: number = Date.now()
): IssueWakeupSpec | null {
  const trigger = wakeupTriggerFromForm(form)
  const instruction = form.instruction.trim()
  if (!trigger || !instruction) return null
  const hours = form.expiresInHours === "" ? null : Number(form.expiresInHours)
  if (hours !== null && !(Number.isFinite(hours) && hours > 0)) return null
  const expiresAt = hours === null ? undefined : new Date(now + hours * 3_600_000)
  if (
    !Number.isInteger(form.maxFires) ||
    form.maxFires < 1 ||
    form.maxFires > ISSUE_WAKEUP_MAX_FIRES_LIMIT
  ) {
    return null
  }
  return {
    issueId,
    instruction,
    trigger,
    maxFires: form.maxFires,
    ...(ONCE_CAPABLE.has(form.preset) ? { once: form.once } : {}),
    ...(expiresAt ? { expiresAt, onTimeout: form.wakeOnTimeout ? "wake" : "drop" } : {}),
    author: { kind: "human" },
  }
}

/**
 * A refusal in the user's language. The policy's own message is already the
 * sentence every schedule surface shows, so it passes through; the tracker's
 * refusals are keyed.
 */
export function describeWakeupWriteError(cause: unknown, t: (key: string) => string): string {
  if (cause instanceof IssueWakeupWriteError && cause.reason !== "policy") {
    return t(`error.${cause.reason}`)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

export interface WakeupCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  issueId: string
  identifier: string
  items?: readonly UnifiedIssueItem[]
}

export function WakeupCreateDialog({
  open,
  onOpenChange,
  issueId,
  identifier,
  items = [],
}: WakeupCreateDialogProps) {
  const t = useTranslations("issues.wakeups")
  const tStatus = useTranslations("issues.status")
  const tCreate = useTranslations("issues.create")
  const [form, setForm] = useState<WakeupFormState>(INITIAL_WAKEUP_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof WakeupFormState>(key: K, value: WakeupFormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }))

  // Open local issues other than this one: the only issues a rule can watch.
  const targets = useMemo(
    () =>
      items.filter(
        (item) =>
          item.kind === "local" &&
          item.unifiedId !== `local:${issueId}` &&
          !isTerminalIssueStatus(item.status)
      ),
    [items, issueId]
  )
  const spec = wakeupSpecFromForm(issueId, form)

  async function submit() {
    // Re-derived at the click, so the deadline counts from when it was made.
    const final = wakeupSpecFromForm(issueId, form, Date.now())
    if (!final) return
    setBusy(true)
    setError(null)
    try {
      await createIssueWakeup({ ...final, source: "user", createdBy: { kind: "user" } })
      toast.success(t("createdToast", { identifier }))
      onOpenChange(false)
    } catch (cause) {
      setError(describeWakeupWriteError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="wakeup-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("createTitle", { identifier })}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wakeup-preset">{t("presetLabel")}</Label>
            <Select
              value={form.preset}
              onValueChange={(value) => set("preset", value as WakeupPreset)}
            >
              <SelectTrigger id="wakeup-preset" data-testid="wakeup-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WAKEUP_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {t(`preset.${preset}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`presetHint.${form.preset}`)}</p>
          </div>

          {form.preset === "comment" ? (
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="wakeup-people-only">{t("peopleOnly")}</Label>
              <Switch
                id="wakeup-people-only"
                checked={form.peopleOnly}
                onCheckedChange={(checked) => set("peopleOnly", checked)}
                data-testid="wakeup-people-only"
              />
            </div>
          ) : null}

          {form.preset === "status" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wakeup-to-status">{t("toStatus")}</Label>
              <Select
                value={form.toStatus}
                onValueChange={(value) => set("toStatus", value as IssueStatus)}
              >
                <SelectTrigger id="wakeup-to-status" data-testid="wakeup-to-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {tStatus(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {form.preset === "children-done" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wakeup-stage">{t("stage")}</Label>
              <Input
                id="wakeup-stage"
                type="number"
                min={1}
                max={ISSUE_STAGE_MAX}
                step={1}
                inputMode="numeric"
                value={form.stage}
                placeholder={t("stagePlaceholder")}
                onChange={(event) => set("stage", event.target.value)}
                data-testid="wakeup-stage"
              />
              <p className="text-xs text-muted-foreground">{t("stageHint")}</p>
            </div>
          ) : null}

          {form.preset === "issue-finished" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wakeup-target">{t("target")}</Label>
              {targets.length > 0 ? (
                <Select
                  value={form.targetIssueId}
                  onValueChange={(value) => set("targetIssueId", value)}
                >
                  <SelectTrigger id="wakeup-target" data-testid="wakeup-target">
                    <SelectValue placeholder={t("targetPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((item) => (
                      <SelectItem
                        key={item.unifiedId}
                        value={item.unifiedId.replace(/^local:/, "")}
                      >
                        {item.identifier} · {item.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="wakeup-no-targets">
                  {t("noTargets")}
                </p>
              )}
            </div>
          ) : null}

          {form.preset === "daily" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wakeup-daily-at">{t("dailyAt")}</Label>
              <Input
                id="wakeup-daily-at"
                type="time"
                value={form.dailyAt}
                onChange={(event) => set("dailyAt", event.target.value)}
                data-testid="wakeup-daily-at"
              />
            </div>
          ) : null}

          {form.preset === "interval" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wakeup-interval">{t("intervalHours")}</Label>
              <Input
                id="wakeup-interval"
                type="number"
                min={1}
                value={form.intervalHours}
                onChange={(event) => set("intervalHours", Number(event.target.value))}
                data-testid="wakeup-interval"
              />
            </div>
          ) : null}

          {form.preset === "at" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wakeup-at">{t("at")}</Label>
              <Input
                id="wakeup-at"
                type="datetime-local"
                value={form.at}
                onChange={(event) => set("at", event.target.value)}
                data-testid="wakeup-at"
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wakeup-instruction">{t("instruction")}</Label>
            <Textarea
              id="wakeup-instruction"
              value={form.instruction}
              maxLength={ISSUE_WAKEUP_INSTRUCTION_MAX}
              placeholder={t("instructionPlaceholder")}
              onChange={(event) => set("instruction", event.target.value)}
              data-testid="wakeup-instruction"
            />
          </div>

          <div className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="wakeup-max-fires">{t("maxFires")}</Label>
              <Input
                id="wakeup-max-fires"
                type="number"
                min={1}
                max={ISSUE_WAKEUP_MAX_FIRES_LIMIT}
                value={form.maxFires}
                onChange={(event) => set("maxFires", Number(event.target.value))}
                data-testid="wakeup-max-fires"
              />
            </div>
            {ONCE_CAPABLE.has(form.preset) ? (
              <div className="flex items-center gap-2 pb-2">
                <Switch
                  id="wakeup-once"
                  checked={form.once}
                  onCheckedChange={(checked) => set("once", checked)}
                  data-testid="wakeup-once"
                />
                <Label htmlFor="wakeup-once">{t("once")}</Label>
              </div>
            ) : null}
          </div>
          <div className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="wakeup-expires">{t("expiresLabel")}</Label>
              <Select
                value={form.expiresInHours || "none"}
                onValueChange={(value) => set("expiresInHours", value === "none" ? "" : value)}
              >
                <SelectTrigger id="wakeup-expires" data-testid="wakeup-expires">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("expiresIn.none")}</SelectItem>
                  {WAKEUP_EXPIRY_HOURS.map((hours) => (
                    <SelectItem key={hours} value={hours}>
                      {t(`expiresIn.${hours}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.expiresInHours ? (
              <div className="flex items-center gap-2 pb-2">
                <Switch
                  id="wakeup-wake-on-timeout"
                  checked={form.wakeOnTimeout}
                  onCheckedChange={(checked) => set("wakeOnTimeout", checked)}
                  data-testid="wakeup-wake-on-timeout"
                />
                <Label htmlFor="wakeup-wake-on-timeout">{t("wakeOnTimeout")}</Label>
              </div>
            ) : null}
          </div>
          {form.expiresInHours ? (
            <p className="text-xs text-muted-foreground">
              {form.wakeOnTimeout ? t("wakeOnTimeoutHint") : t("dropOnTimeoutHint")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("safetyHint")}</p>

          {error ? (
            <p className="text-sm text-destructive" data-testid="wakeup-create-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {tCreate("cancel")}
          </Button>
          <Button onClick={submit} disabled={!spec || busy} data-testid="wakeup-create-submit">
            <AlarmClockIcon className="size-4" />
            {t("createSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
