"use client"

/**
 * Shared editor for `ConversationOverrideRow` fields (im-refactored-crayon).
 *
 * Mounted at two call sites:
 *   1. Settings → Connections → Conversations tab "Edit" button
 *   2. Inbox → conversation header gear icon
 *
 * Both paths use the same form so per-channel behaviour stays consistent
 * regardless of where the operator opened it.
 *
 * Save persists via `upsertByConversationKey` (creates a row if none
 * exists yet; bumps `updatedAt` otherwise). Delete-Override removes the
 * row entirely so the channel falls back to its adapter defaults.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { InfoIcon, ShieldAlertIcon, XIcon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type {
  ActiveRunDispatchMode,
  ConnectorMode,
  InboundActivationPolicy,
} from "@/types/connectors/policy"

type SkillAllowMode = "inherit" | "all" | "whitelist"

interface QuietHoursDraft {
  enabled: boolean
  from: string
  to: string
  tz: string
}

function deriveSkillMode(value: ConversationOverrideRow["allowedBuiltInSkillIds"]): SkillAllowMode {
  if (value === undefined) return "inherit"
  if (value === "all") return "all"
  return "whitelist"
}

/** Parse the SLA-minutes text buffer into a positive integer, or undefined. */
function parseSlaMinutes(buffer: string): number | undefined {
  const trimmed = buffer.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function parseActivationTtlMs(buffer: string): number | undefined {
  const hours = Number(buffer.trim())
  return Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3_600_000) : undefined
}

const MODES: ReadonlyArray<{ value: ConnectorMode | "unset"; key: string }> = [
  { value: "unset", key: "unset" },
  { value: "auto", key: "auto" },
  { value: "manual", key: "manual" },
  { value: "draft", key: "draft" },
]

export interface ConversationOverrideFormProps {
  /** Bus-level adapter id (the middle segment of `conversationKey`). */
  adapterId: string
  /** `${platform}:${adapterId}:${chatId}`. */
  conversationKey: string
  /** Existing row, if any; null = creating a new override. */
  initialRow?: ConversationOverrideRow | null
  /** Inbox-bound conversations carry a fresh ChatSession; required to
   * upsert. Settings callers can derive it from the conversationKey. */
  sessionId: string
  /** Called after a successful Save / Delete. */
  onDone?: () => void
  /** Called when Cancel is clicked. */
  onCancel?: () => void
}

export function ConversationOverrideForm(props: ConversationOverrideFormProps) {
  const { adapterId, conversationKey, initialRow, sessionId, onDone, onCancel } = props
  const t = useTranslations("inbox.conversationOverride")

  const [mode, setMode] = useState<ConnectorMode | "unset">(
    (initialRow?.mode as ConnectorMode | undefined) ?? "unset"
  )
  const [activationPolicy, setActivationPolicy] = useState<InboundActivationPolicy | "inherit">(
    initialRow?.inboundActivationPolicy ?? "inherit"
  )
  const [dispatchMode, setDispatchMode] = useState<ActiveRunDispatchMode | "inherit">(
    initialRow?.activeRunDispatchMode ?? "inherit"
  )
  const [activationTtlHours, setActivationTtlHours] = useState(
    initialRow?.activationTtlMs ? String(initialRow.activationTtlMs / 3_600_000) : ""
  )
  const [characterId, setCharacterId] = useState(initialRow?.characterId ?? "")
  // Agent Team binding (control-plane multi-agent). When set, inbound AI-run
  // routes to the team runtime instead of the single character.
  const [teamId, setTeamId] = useState(initialRow?.teamId ?? "")
  const [workflowId, setWorkflowId] = useState(initialRow?.workflowId ?? "")
  const [allowComputerUse, setAllowComputerUse] = useState(initialRow?.allowComputerUse ?? false)
  const [allowGoalDriving, setAllowGoalDriving] = useState(initialRow?.allowGoalDriving ?? false)
  const [allowScheduleTools, setAllowScheduleTools] = useState(
    initialRow?.allowScheduleTools ?? false
  )
  // Proactive IM push opt-in (control-plane notifications). Default OFF.
  const [proactivePush, setProactivePush] = useState(initialRow?.proactivePush ?? false)
  // Live in-turn activity card (control-plane visibility). DEFAULT ON —
  // persist `false` only to suppress for noisy channels.
  const [liveActivity, setLiveActivity] = useState(initialRow?.liveActivity !== false)
  const [appendActivity, setAppendActivity] = useState(initialRow?.appendActivity !== false)
  const [providerOverride, setProviderOverride] = useState(initialRow?.providerOverride ?? "")
  const [modelOverride, setModelOverride] = useState(initialRow?.modelOverride ?? "")
  const [pinned, setPinned] = useState(initialRow?.pinned ?? false)
  const [archived, setArchived] = useState(initialRow?.archived ?? false)
  // Per-conversation outbound mute (fine-grained control) — consulted by the
  // outbound runner with the same defer semantics as the adapter-level mute.
  const [muted, setMuted] = useState(initialRow?.muted ?? false)
  // Response-SLA target in minutes (CRM, schema v83). Empty string = no SLA.
  const [slaMinutes, setSlaMinutes] = useState<string>(
    initialRow?.slaResponseMinutes != null ? String(initialRow.slaResponseMinutes) : ""
  )
  const [saving, setSaving] = useState(false)

  // Quiet hours — toggle + three inputs. The "enabled" boolean tracks
  // whether the operator wants to send a quietHours object on save or
  // clear the existing one.
  const [quietHours, setQuietHours] = useState<QuietHoursDraft>({
    enabled: Boolean(initialRow?.quietHours),
    from: initialRow?.quietHours?.from ?? "22:00",
    to: initialRow?.quietHours?.to ?? "08:00",
    tz: initialRow?.quietHours?.tz ?? "UTC",
  })

  // Skill allowlist tri-state: inherit / all / whitelist. Whitelist mode
  // captures a comma- or newline-separated id list (or wildcard patterns
  // like `lark.calendar.*`) into a controlled string buffer.
  const [skillMode, setSkillMode] = useState<SkillAllowMode>(() =>
    deriveSkillMode(initialRow?.allowedBuiltInSkillIds)
  )
  const initialSkillIds = useMemo(() => {
    const v = initialRow?.allowedBuiltInSkillIds
    return Array.isArray(v) ? v : []
  }, [initialRow])
  const [skillInput, setSkillInput] = useState("")
  const [skillIds, setSkillIds] = useState<string[]>(initialSkillIds)

  // HITL on write skills — defaults true if undefined in the row, matching
  // ADR-0026's safe-by-default contract.
  const [requireHitlForWrites, setRequireHitlForWrites] = useState<boolean>(
    initialRow?.requireHitlForWrites ?? true
  )

  function addSkillFromInput(): void {
    const raw = skillInput.trim()
    if (!raw) return
    const next = new Set(skillIds)
    for (const token of raw
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)) {
      next.add(token)
    }
    setSkillIds(Array.from(next))
    setSkillInput("")
  }

  function removeSkill(id: string): void {
    setSkillIds((prev) => prev.filter((s) => s !== id))
  }

  // Resetting on initialRow changes is handled at the call site via a `key`
  // prop on this component (see ConversationOverrideDialog) — that triggers
  // a fresh mount with the new initial values and avoids the
  // react-hooks/set-state-in-effect anti-pattern.

  const onSave = async () => {
    setSaving(true)
    try {
      // Resolve allowedBuiltInSkillIds based on the tri-state:
      //   inherit   → undefined (fall back to adapter / global defaults)
      //   all       → literal "all"
      //   whitelist → trimmed string[]
      let resolvedAllowed: ConversationOverrideRow["allowedBuiltInSkillIds"]
      if (skillMode === "inherit") resolvedAllowed = undefined
      else if (skillMode === "all") resolvedAllowed = "all"
      else resolvedAllowed = skillIds
      const resolvedQuietHours =
        quietHours.enabled && quietHours.from && quietHours.to && quietHours.tz
          ? { from: quietHours.from, to: quietHours.to, tz: quietHours.tz }
          : undefined
      await upsertByConversationKey({
        conversationKey,
        sessionId,
        mode: mode === "unset" ? undefined : mode,
        inboundActivationPolicy: activationPolicy === "inherit" ? undefined : activationPolicy,
        activeRunDispatchMode: dispatchMode === "inherit" ? undefined : dispatchMode,
        activationTtlMs: parseActivationTtlMs(activationTtlHours),
        characterId: characterId.trim() || undefined,
        teamId: teamId.trim() || undefined,
        workflowId: workflowId.trim() || undefined,
        proactivePush: proactivePush ? true : undefined,
        liveActivity: liveActivity ? undefined : false,
        appendActivity: appendActivity ? undefined : false,
        allowComputerUse: allowComputerUse ? true : undefined,
        allowGoalDriving: allowGoalDriving ? true : undefined,
        allowScheduleTools: allowScheduleTools ? true : undefined,
        providerOverride: providerOverride.trim() || undefined,
        modelOverride: modelOverride.trim() || undefined,
        pinned: pinned ? true : undefined,
        archived: archived ? true : undefined,
        muted: muted ? true : undefined,
        trigger: initialRow?.trigger,
        allowedBuiltInSkillIds: resolvedAllowed,
        // The HITL flag defaults true at the read site; only persist when
        // explicitly set to false so older rows don't get migration churn.
        requireHitlForWrites: requireHitlForWrites === false ? false : undefined,
        quietHours: resolvedQuietHours,
        slaResponseMinutes: parseSlaMinutes(slaMinutes),
      })
      onDone?.()
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async () => {
    if (!initialRow) {
      onCancel?.()
      return
    }
    await getDb().conversationOverrides.delete(initialRow.id)
    onDone?.()
  }

  const [applyingToAdapter, setApplyingToAdapter] = useState(false)

  /**
   * v49 — Apply the in-form values (pinned / archived / allowComputerUse /
   * allowGoalDriving / mode / quietHours / character / provider+model /
   * skill allowlist) to every conversation that shares this adapter.
   * Lets the operator say "make every Slack channel default to draft mode
   * with goal-driving off" in one click instead of editing each override.
   *
   * Bulk path is transactional so a half-applied batch can't leak through
   * if Dexie throws midway. The audit row is per-conversation already (via
   * upsertByConversationKey), so no extra audit work is needed here.
   */
  const onApplyToAdapter = async () => {
    if (!adapterId) return
    if (typeof window !== "undefined") {
      const ok = window.confirm(t("fields.applyToAdapterConfirm"))
      if (!ok) return
    }
    setApplyingToAdapter(true)
    try {
      let resolvedAllowed: ConversationOverrideRow["allowedBuiltInSkillIds"]
      if (skillMode === "inherit") resolvedAllowed = undefined
      else if (skillMode === "all") resolvedAllowed = "all"
      else resolvedAllowed = skillIds
      const resolvedQuietHours =
        quietHours.enabled && quietHours.from && quietHours.to && quietHours.tz
          ? { from: quietHours.from, to: quietHours.to, tz: quietHours.tz }
          : undefined

      const db = getDb()
      // Identify the conversations belonging to this adapter via the
      // adapter middle segment of the conversationKey. We also pull any
      // sessions bound to the adapter that have NO override yet so the
      // bulk apply creates fresh override rows for them.
      const adapterPrefix = `:${adapterId}:`
      const existing = await db.conversationOverrides
        .filter((row) => row.conversationKey.includes(adapterPrefix))
        .toArray()
      const sessions = await db.sessions
        .filter((s) => s.platformBinding?.adapterId === adapterId)
        .toArray()
      const knownKeys = new Set(existing.map((r) => r.conversationKey))
      const targets: Array<{ conversationKey: string; sessionId: string }> = [
        ...existing.map((r) => ({ conversationKey: r.conversationKey, sessionId: r.sessionId })),
        ...sessions
          .filter((s) => s.platformBinding && !knownKeys.has(s.platformBinding.conversationKey))
          .map((s) => ({
            conversationKey: s.platformBinding!.conversationKey,
            sessionId: s.id,
          })),
      ]
      for (const target of targets) {
        // Re-apply the form values per-conversation. We deliberately call
        // the existing upsert helper instead of `bulkPut` so the per-row
        // audit + updatedAt bump path stays consistent with single-row
        // saves.
        await upsertByConversationKey({
          conversationKey: target.conversationKey,
          sessionId: target.sessionId,
          mode: mode === "unset" ? undefined : mode,
          inboundActivationPolicy: activationPolicy === "inherit" ? undefined : activationPolicy,
          activeRunDispatchMode: dispatchMode === "inherit" ? undefined : dispatchMode,
          activationTtlMs: parseActivationTtlMs(activationTtlHours),
          characterId: characterId.trim() || undefined,
          teamId: teamId.trim() || undefined,
          workflowId: workflowId.trim() || undefined,
          allowComputerUse: allowComputerUse ? true : undefined,
          allowGoalDriving: allowGoalDriving ? true : undefined,
          providerOverride: providerOverride.trim() || undefined,
          modelOverride: modelOverride.trim() || undefined,
          pinned: pinned ? true : undefined,
          archived: archived ? true : undefined,
          muted: muted ? true : undefined,
          allowedBuiltInSkillIds: resolvedAllowed,
          requireHitlForWrites: requireHitlForWrites === false ? false : undefined,
          quietHours: resolvedQuietHours,
          slaResponseMinutes: parseSlaMinutes(slaMinutes),
        })
      }
      onDone?.()
    } finally {
      setApplyingToAdapter(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="border-b pb-3 text-xs font-mono text-muted-foreground">{conversationKey}</div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-mode">{t("fields.mode")}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as ConnectorMode | "unset")}>
          <SelectTrigger id="conv-override-mode" data-testid="conv-override-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {t(`fields.modeOptions.${m.key}`)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-3 border-b pb-5 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="conv-override-activation-policy">
            {t("fields.activationPolicy.label")}
          </Label>
          <Select
            value={activationPolicy}
            onValueChange={(value) =>
              setActivationPolicy(value as InboundActivationPolicy | "inherit")
            }
          >
            <SelectTrigger
              id="conv-override-activation-policy"
              data-testid="conv-override-activation-policy"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(
                  ["inherit", "mention_activates", "mention_each", "always", "direct_only"] as const
                ).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`fields.activationPolicy.options.${value}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="conv-override-dispatch-mode">{t("fields.dispatchMode.label")}</Label>
          <Select
            value={dispatchMode}
            onValueChange={(value) => setDispatchMode(value as ActiveRunDispatchMode | "inherit")}
          >
            <SelectTrigger
              id="conv-override-dispatch-mode"
              data-testid="conv-override-dispatch-mode"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(["inherit", "queue", "steer"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`fields.dispatchMode.options.${value}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="conv-override-activation-ttl">{t("fields.activationTtl.label")}</Label>
          <Input
            id="conv-override-activation-ttl"
            type="number"
            min="1"
            step="1"
            value={activationTtlHours}
            placeholder={t("fields.activationTtl.placeholder")}
            onChange={(event) => setActivationTtlHours(event.target.value)}
            data-testid="conv-override-activation-ttl"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-character">{t("fields.character")}</Label>
        <Input
          id="conv-override-character"
          value={characterId}
          placeholder={t("fields.characterPlaceholder")}
          onChange={(e) => setCharacterId(e.target.value)}
          data-testid="conv-override-character"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-team">{t("fields.teamBinding")}</Label>
        <Input
          id="conv-override-team"
          value={teamId}
          placeholder={t("fields.teamBindingPlaceholder")}
          onChange={(e) => setTeamId(e.target.value)}
          data-testid="conv-override-team"
        />
        <p className="text-[11px] text-muted-foreground">{t("fields.teamBindingHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-workflow">{t("fields.workflowBinding")}</Label>
        <Input
          id="conv-override-workflow"
          value={workflowId}
          placeholder={t("fields.workflowBindingPlaceholder")}
          onChange={(e) => setWorkflowId(e.target.value)}
          data-testid="conv-override-workflow"
        />
        <p className="text-[11px] text-muted-foreground">{t("fields.workflowBindingHelp")}</p>
      </div>

      <div className="flex flex-col gap-4 border-b pb-5">
        <div className="flex items-start gap-2">
          <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="conv-override-cu" className="cursor-pointer">
                {t("fields.allowComputerUse")}
              </Label>
              <Switch
                id="conv-override-cu"
                checked={allowComputerUse}
                onCheckedChange={setAllowComputerUse}
                data-testid="conv-override-cu"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("fields.allowComputerUseWarning")}</p>
          </div>
        </div>
        {/* v49 — Per-conversation opt-in for self-driving `/goal` on
         * IM channels. Off by default so a goal loop cannot auto-reply
         * without operator review. */}
        <div className="flex items-start gap-3 border-t pt-4">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="conv-override-goal" className="cursor-pointer">
                {t("fields.allowGoalDriving")}
              </Label>
              <Switch
                id="conv-override-goal"
                checked={allowGoalDriving}
                onCheckedChange={setAllowGoalDriving}
                data-testid="conv-override-goal"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("fields.allowGoalDrivingWarning")}</p>
            <p className="text-xs text-muted-foreground">{t("fields.allowGoalDrivingPlatform")}</p>
          </div>
        </div>
        <div className="flex items-start gap-3 border-t pt-4">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="conv-override-schedule-tools" className="cursor-pointer">
                {t("fields.allowScheduleTools")}
              </Label>
              <Switch
                id="conv-override-schedule-tools"
                checked={allowScheduleTools}
                onCheckedChange={setAllowScheduleTools}
                data-testid="conv-override-schedule-tools"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("fields.allowScheduleToolsWarning")}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="conv-override-provider">{t("fields.providerOverride")}</Label>
          <Input
            id="conv-override-provider"
            value={providerOverride}
            placeholder={t("fields.providerOverridePlaceholder")}
            onChange={(e) => setProviderOverride(e.target.value)}
            data-testid="conv-override-provider"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="conv-override-model">{t("fields.modelOverride")}</Label>
          <Input
            id="conv-override-model"
            value={modelOverride}
            placeholder={t("fields.modelOverridePlaceholder")}
            onChange={(e) => setModelOverride(e.target.value)}
            data-testid="conv-override-model"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-sla">{t("fields.slaResponseMinutes")}</Label>
        <Input
          id="conv-override-sla"
          type="number"
          min={1}
          inputMode="numeric"
          value={slaMinutes}
          placeholder={t("fields.slaResponseMinutesPlaceholder")}
          onChange={(e) => setSlaMinutes(e.target.value)}
          data-testid="conv-override-sla"
        />
        <p className="text-xs text-muted-foreground">{t("fields.slaResponseMinutesHint")}</p>
      </div>

      {/* Proactive IM push opt-in (control-plane notifications). Off by default
       * so a customer-facing channel never gets surprise pushes. */}
      <div className="flex items-start gap-3 border-b pb-5">
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="conv-override-proactive" className="cursor-pointer">
              {t("fields.proactivePush")}
            </Label>
            <Switch
              id="conv-override-proactive"
              checked={proactivePush}
              onCheckedChange={setProactivePush}
              data-testid="conv-override-proactive"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("fields.proactivePushHint")}</p>
        </div>
      </div>

      {/* Live activity card opt-OUT (control-plane visibility). DEFAULT ON —
       * the live "the agent is working" card surfaces tool count / elapsed /
       * file edits during a turn. Flip OFF to suppress on noisy channels. */}
      <div className="flex items-start gap-3 border-b pb-5">
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="conv-override-live-activity" className="cursor-pointer">
              {t("fields.liveActivity")}
            </Label>
            <Switch
              id="conv-override-live-activity"
              checked={liveActivity}
              onCheckedChange={setLiveActivity}
              data-testid="conv-override-live-activity"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("fields.liveActivityHint")}</p>
        </div>
      </div>

      {/* Append-mode activity opt-OUT for adapters WITHOUT edit() (workflow⇄IM
       * visibility parity). DEFAULT ON — such adapters get one compact progress
       * line per boundary during a turn. Flip OFF to suppress on noisy channels. */}
      <div className="flex items-start gap-3 border-b pb-5">
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="conv-override-append-activity" className="cursor-pointer">
              {t("fields.appendActivity")}
            </Label>
            <Switch
              id="conv-override-append-activity"
              checked={appendActivity}
              onCheckedChange={setAppendActivity}
              data-testid="conv-override-append-activity"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("fields.appendActivityHint")}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-b pb-5 sm:grid-cols-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="conv-override-pinned" className="cursor-pointer">
            {t("fields.pinned")}
          </Label>
          <Switch
            id="conv-override-pinned"
            checked={pinned}
            onCheckedChange={setPinned}
            data-testid="conv-override-pinned"
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="conv-override-archived" className="cursor-pointer">
            {t("fields.archived")}
          </Label>
          <Switch
            id="conv-override-archived"
            checked={archived}
            onCheckedChange={setArchived}
            data-testid="conv-override-archived"
          />
        </div>
      </div>

      {/* Per-conversation outbound mute — same defer semantics as the
       * adapter-level mute, scoped to this conversation only. */}
      <div className="flex items-start gap-3 border-b pb-5">
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="conv-override-muted" className="cursor-pointer">
              {t("fields.muted")}
            </Label>
            <Switch
              id="conv-override-muted"
              checked={muted}
              onCheckedChange={setMuted}
              data-testid="conv-override-muted"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("fields.mutedHint")}</p>
        </div>
      </div>

      {/* Quiet hours — per-conversation override that beats the adapter
       * default in `outbound-runner`. */}
      <div className="flex flex-col gap-2 border-b pb-5">
        <div className="flex items-center justify-between">
          <Label htmlFor="conv-override-quiet-enabled" className="cursor-pointer">
            {t("fields.quietHours.enabled")}
          </Label>
          <Switch
            id="conv-override-quiet-enabled"
            checked={quietHours.enabled}
            onCheckedChange={(v) => setQuietHours((prev) => ({ ...prev, enabled: v }))}
            data-testid="conv-override-quiet-enabled"
          />
        </div>
        {quietHours.enabled && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="conv-override-quiet-from">
                {t("fields.quietHours.from")}
              </Label>
              <Input
                id="conv-override-quiet-from"
                type="time"
                value={quietHours.from}
                onChange={(e) => setQuietHours((prev) => ({ ...prev, from: e.target.value }))}
                data-testid="conv-override-quiet-from"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="conv-override-quiet-to">
                {t("fields.quietHours.to")}
              </Label>
              <Input
                id="conv-override-quiet-to"
                type="time"
                value={quietHours.to}
                onChange={(e) => setQuietHours((prev) => ({ ...prev, to: e.target.value }))}
                data-testid="conv-override-quiet-to"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="conv-override-quiet-tz">
                {t("fields.quietHours.tz")}
              </Label>
              <Input
                id="conv-override-quiet-tz"
                value={quietHours.tz}
                onChange={(e) => setQuietHours((prev) => ({ ...prev, tz: e.target.value }))}
                // i18n-exempt: example IANA timezone id, not translatable UI copy
                placeholder="Asia/Shanghai"
                data-testid="conv-override-quiet-tz"
              />
            </div>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">{t("fields.quietHours.help")}</p>
      </div>

      {/* Built-in skill allowlist — tri-state radio + chip-input for the
       * whitelist branch. Inherit falls back to the adapter / global
       * defaults; "all" opens every registered skill (still subject to
       * HITL routing). */}
      <div className="flex flex-col gap-2 border-b pb-5">
        <Label className="cursor-pointer">{t("fields.allowedSkills.label")}</Label>
        <RadioGroup
          value={skillMode}
          onValueChange={(v) => setSkillMode(v as SkillAllowMode)}
          className="flex flex-wrap gap-3 text-xs"
        >
          <label className="flex items-center gap-1.5">
            <RadioGroupItem
              value="inherit"
              id="conv-override-skills-inherit"
              data-testid="conv-override-skills-inherit"
            />
            <span>{t("fields.allowedSkills.inherit")}</span>
          </label>
          <label className="flex items-center gap-1.5">
            <RadioGroupItem
              value="all"
              id="conv-override-skills-all"
              data-testid="conv-override-skills-all"
            />
            <span>{t("fields.allowedSkills.all")}</span>
          </label>
          <label className="flex items-center gap-1.5">
            <RadioGroupItem
              value="whitelist"
              id="conv-override-skills-whitelist"
              data-testid="conv-override-skills-whitelist"
            />
            <span>{t("fields.allowedSkills.whitelist")}</span>
          </label>
        </RadioGroup>
        {skillMode === "whitelist" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={skillInput}
                placeholder={t("fields.allowedSkills.placeholder")}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault()
                    addSkillFromInput()
                  }
                }}
                onBlur={() => addSkillFromInput()}
                data-testid="conv-override-skills-input"
                className="text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addSkillFromInput}
                data-testid="conv-override-skills-add"
              >
                {t("fields.allowedSkills.add")}
              </Button>
            </div>
            {skillIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="conv-override-skills-chips">
                {skillIds.map((id) => (
                  <Badge key={id} variant="secondary" className="gap-1 pr-1 text-[11px]">
                    <span className="font-mono">{id}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeSkill(id)}
                      aria-label={t("fields.allowedSkills.remove", { id })}
                      data-testid={`conv-override-skills-remove-${id}`}
                      className="size-4"
                    >
                      <XIcon className="size-2.5" aria-hidden />
                    </Button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">{t("fields.allowedSkills.help")}</p>
      </div>

      {/* HITL guard on write-tier skills (defaults true). Off makes the
       * channel "trusted" so write skills don't pop a confirm card. */}
      <Alert variant="destructive" className="rounded-none border-x-0 bg-transparent">
        <ShieldAlertIcon aria-hidden />
        <AlertDescription>
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="conv-override-hitl" className="cursor-pointer">
                {t("fields.requireHitlForWrites.label")}
              </Label>
              <Switch
                id="conv-override-hitl"
                checked={requireHitlForWrites}
                onCheckedChange={setRequireHitlForWrites}
                data-testid="conv-override-hitl"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("fields.requireHitlForWrites.help")}</p>
          </div>
        </AlertDescription>
      </Alert>

      <Alert
        className="rounded-none border-x-0 bg-transparent text-xs"
        data-testid="conv-override-quiet-hours-notice"
      >
        <InfoIcon aria-hidden />
        <AlertDescription>{t("fields.advancedJsonHelp")}</AlertDescription>
      </Alert>

      <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {initialRow && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onDelete}
              data-testid="conv-override-delete"
            >
              {t("deleteOverride")}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={onApplyToAdapter}
            disabled={applyingToAdapter || saving || !adapterId}
            data-testid="conv-override-apply-to-adapter"
            title={t("fields.applyToAdapterTitle")}
          >
            {applyingToAdapter ? t("saving") : t("fields.applyToAdapter")}
          </Button>
          <Button variant="ghost" onClick={onCancel} data-testid="conv-override-cancel">
            {t("reset")}
          </Button>
          <Button onClick={onSave} disabled={saving} data-testid="conv-override-save">
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </div>
    </div>
  )
}
