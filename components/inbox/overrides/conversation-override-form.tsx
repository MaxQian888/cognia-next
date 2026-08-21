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
import type { Character } from "@cognia/agent-config-types"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ASSIGNMENT_ROUTING_MARKER_CLEAR } from "@/lib/db/conversation-overrides"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { parseConversationKey } from "@/types/connectors/event"
import type { EscalationPolicy } from "@/types/connectors/escalation"
import { EscalationPolicyEditor } from "./escalation-policy-editor"
import { updateAdapterConfigSection, type AdapterInstancePatch } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type {
  ActiveRunDispatchMode,
  ConnectorMode,
  InboundActivationPolicy,
} from "@/types/connectors/policy"
import { ConversationBehaviorEditor } from "@/components/settings/connections/forms/conversation-behavior-editor"
import type { ImConfigSource, ImExecutionTarget } from "@/lib/connectors/effective-config"
import { EntityPicker } from "@/components/settings/connections/forms/_shared/entity-picker"
import { TeamPicker } from "@/components/settings/connections/forms/_shared/team-picker"
import { collectOptions } from "@/components/inbox/provider-model-switcher"
import type { AppSettings } from "@cognia/agent-config-types"

type SkillAllowMode = "inherit" | "all" | "whitelist"

interface QuietHoursDraft {
  enabled: boolean
  from: string
  to: string
  tz: string
}

const PROMOTION_FIELD_LABELS = {
  defaultMode: "mode",
  inboundActivationPolicy: "activationPolicy",
  activeRunDispatchMode: "dispatchMode",
  activationTtlMs: "activationTtl",
  defaultCharacterId: "character",
  defaultTeamId: "team",
  defaultWorkflowId: "workflow",
  defaultProvider: "provider",
  defaultModel: "model",
  muted: "muted",
  quietHours: "quietHours",
  builtInSkillCeiling: "builtInSkillCeiling",
  requireHitlForWrites: "requireHitlForWrites",
} as const satisfies Partial<Record<keyof AdapterInstancePatch, string>>

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
  /** Canonical effective-config provenance resolved by the caller. */
  effectiveSources?: Partial<
    Record<
      "mode" | "inboundActivationPolicy" | "activeRunDispatchMode" | "activationTtlHours",
      ImConfigSource
    >
  >
  effectiveTargetKind?: ImExecutionTarget["kind"]
}

/** Typed empty default — a bare `[]` infers `never[]` and poisons every read. */
const EMPTY_CHARACTERS: Character[] = []

export function ConversationOverrideForm(props: ConversationOverrideFormProps) {
  const {
    adapterId,
    conversationKey,
    initialRow,
    sessionId,
    onDone,
    onCancel,
    effectiveSources,
    effectiveTargetKind,
  } = props
  const t = useTranslations("inbox.conversationOverride")
  // The SSR branch and the default both need the row type spelled out; a bare
  // `[]` infers `never[]`, collapses the union, and every field read off a
  // character below then fails with "does not exist on type 'never'".
  const characters = useLiveQuery(
    () =>
      typeof window === "undefined"
        ? Promise.resolve<Character[]>([])
        : getDb().characters.toArray(),
    [],
    EMPTY_CHARACTERS
  )
  const executableWorkflows = useLiveQuery(async () => {
    if (typeof window === "undefined") return []
    const [workflows, deployments] = await Promise.all([
      getDb().workflows.toArray(),
      getDb().workflowDeployments.toArray(),
    ])
    const activeProductionIds = new Set(
      deployments
        .filter(
          (deployment) => deployment.environment === "production" && deployment.status === "active"
        )
        .map((deployment) => deployment.workflowId)
    )
    return workflows.filter((workflow) => activeProductionIds.has(workflow.id))
  }, [])
  const settings = useLiveQuery<AppSettings | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().settings.get("singleton"),
    []
  )
  const providerModelOptions = collectOptions(settings)

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
  const [characterState, setCharacterState] = useState<"inherit" | "none" | "character">(
    initialRow?.characterDisabled ? "none" : initialRow?.characterId ? "character" : "inherit"
  )
  // Agent Team binding (control-plane multi-agent). When set, inbound AI-run
  // routes to the team runtime instead of the single character.
  const [teamId, setTeamId] = useState(initialRow?.teamId ?? "")
  const [workflowId, setWorkflowId] = useState(initialRow?.workflowId ?? "")
  const [targetKind, setTargetKind] = useState<"inherit" | "direct" | "team" | "workflow">(
    initialRow?.teamId
      ? "team"
      : initialRow?.workflowId
        ? "workflow"
        : initialRow?.teamDisabled && initialRow?.workflowDisabled
          ? "direct"
          : "inherit"
  )
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
  const [replyQuoting, setReplyQuoting] = useState(initialRow?.replyQuoting !== false)
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
  // SLA escalation chain (slice 1B). `undefined` = inherit the bot default.
  const [escalation, setEscalation] = useState<EscalationPolicy | undefined>(initialRow?.escalation)
  const platform = useMemo(() => {
    try {
      return parseConversationKey(conversationKey).platform
    } catch {
      return undefined
    }
  }, [conversationKey])
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
      const nextMode = mode === "unset" ? undefined : mode
      const nextCharacterId =
        characterState === "character" ? characterId.trim() || undefined : undefined
      const nextCharacterDisabled = characterState === "none" ? true : undefined
      const nextTeamId = targetKind === "team" ? teamId.trim() || undefined : undefined
      const nextTeamDisabled =
        targetKind === "workflow" || targetKind === "direct" ? true : undefined
      // Explicit routing / mode edit → drop the assignment ↔ routing marker
      // (slice 1A) so a later unassign keeps what the operator chose here.
      // The assignee itself is untouched.
      const routingEdited =
        nextMode !== initialRow?.mode ||
        nextCharacterId !== initialRow?.characterId ||
        nextCharacterDisabled !== initialRow?.characterDisabled ||
        nextTeamId !== initialRow?.teamId ||
        nextTeamDisabled !== initialRow?.teamDisabled
      await mutateConversationOverride({
        kind: "configSection",
        adapterId,
        conversationKey,
        sessionId,
        section: "responder",
        source: "inbox.override.editor",
        patch: {
          ...(routingEdited ? ASSIGNMENT_ROUTING_MARKER_CLEAR : {}),
          mode: nextMode,
          inboundActivationPolicy: activationPolicy === "inherit" ? undefined : activationPolicy,
          activeRunDispatchMode: dispatchMode === "inherit" ? undefined : dispatchMode,
          activationTtlMs: parseActivationTtlMs(activationTtlHours),
          characterId: nextCharacterId,
          characterDisabled: nextCharacterDisabled,
          teamId: nextTeamId,
          teamDisabled: nextTeamDisabled,
          workflowId: targetKind === "workflow" ? workflowId.trim() || undefined : undefined,
          workflowDisabled: targetKind === "team" || targetKind === "direct" ? true : undefined,
          proactivePush: proactivePush ? true : undefined,
          liveActivity: liveActivity ? undefined : false,
          appendActivity: appendActivity ? undefined : false,
          replyQuoting: replyQuoting ? undefined : false,
          allowComputerUse: allowComputerUse ? true : undefined,
          allowGoalDriving: allowGoalDriving ? true : undefined,
          allowScheduleTools: allowScheduleTools ? true : undefined,
          providerOverride:
            targetKind === "team" || targetKind === "workflow"
              ? undefined
              : providerOverride.trim() || undefined,
          modelOverride:
            targetKind === "team" || targetKind === "workflow"
              ? undefined
              : modelOverride.trim() || undefined,
          muted: muted ? true : undefined,
          allowedBuiltInSkillIds: resolvedAllowed,
          requireHitlForWrites: requireHitlForWrites === false ? false : undefined,
          quietHours: resolvedQuietHours,
        },
      })
      await mutateConversationOverride({
        kind: "upsert",
        input: {
          conversationKey,
          sessionId,
          pinned: pinned ? true : undefined,
          archived: archived ? true : undefined,
          slaResponseMinutes: parseSlaMinutes(slaMinutes),
          // undefined = inherit the adapter default (`defaultEscalation`).
          escalation,
        },
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

  const [promotingToAdapter, setPromotingToAdapter] = useState(false)

  const onPromoteToAdapter = async () => {
    if (!adapterId) return
    let resolvedAllowed: ConversationOverrideRow["allowedBuiltInSkillIds"]
    if (skillMode === "inherit") resolvedAllowed = undefined
    else if (skillMode === "all") resolvedAllowed = "all"
    else resolvedAllowed = skillIds
    const resolvedQuietHours =
      quietHours.enabled && quietHours.from && quietHours.to && quietHours.tz
        ? { from: quietHours.from, to: quietHours.to, tz: quietHours.tz }
        : undefined
    const patch: AdapterInstancePatch = {
      ...(mode !== "unset" ? { defaultMode: mode } : {}),
      ...(activationPolicy !== "inherit" ? { inboundActivationPolicy: activationPolicy } : {}),
      ...(dispatchMode !== "inherit" ? { activeRunDispatchMode: dispatchMode } : {}),
      ...(parseActivationTtlMs(activationTtlHours)
        ? { activationTtlMs: parseActivationTtlMs(activationTtlHours) }
        : {}),
      ...(characterState === "character" && characterId.trim()
        ? { defaultCharacterId: characterId.trim() }
        : {}),
      ...(targetKind === "team" && teamId.trim()
        ? { defaultTeamId: teamId.trim(), defaultWorkflowId: undefined }
        : targetKind === "workflow" && workflowId.trim()
          ? { defaultWorkflowId: workflowId.trim(), defaultTeamId: undefined }
          : targetKind === "direct"
            ? { defaultTeamId: undefined, defaultWorkflowId: undefined }
            : {}),
      ...((targetKind === "direct" ||
        (targetKind === "inherit" && effectiveTargetKind === "direct")) &&
      providerOverride.trim()
        ? { defaultProvider: providerOverride.trim() }
        : {}),
      ...((targetKind === "direct" ||
        (targetKind === "inherit" && effectiveTargetKind === "direct")) &&
      modelOverride.trim()
        ? { defaultModel: modelOverride.trim() }
        : {}),
      ...(muted ? { muted: true } : {}),
      ...(resolvedQuietHours ? { quietHours: resolvedQuietHours } : {}),
      ...(resolvedAllowed !== undefined
        ? {
            builtInSkillCeiling: resolvedAllowed === "all" ? undefined : resolvedAllowed,
          }
        : {}),
      ...(initialRow?.requireHitlForWrites !== undefined || !requireHitlForWrites
        ? { requireHitlForWrites }
        : {}),
    }
    const changedKeys = Object.keys(patch) as Array<keyof typeof PROMOTION_FIELD_LABELS>
    if (changedKeys.length === 0) return
    const translatedChanges = changedKeys
      .map((key) => t(`fields.promotionFields.${PROMOTION_FIELD_LABELS[key]}`))
      .join(", ")
    if (
      typeof window !== "undefined" &&
      !window.confirm(t("fields.promoteConfirm", { changes: translatedChanges }))
    ) {
      return
    }
    if (
      typeof window !== "undefined" &&
      ("builtInSkillCeiling" in patch || "requireHitlForWrites" in patch) &&
      !window.confirm(t("fields.promotePermissionConfirm"))
    ) {
      return
    }
    setPromotingToAdapter(true)
    try {
      await updateAdapterConfigSection(adapterId, "promotion", patch, "conversation-promotion")
      onDone?.()
    } finally {
      setPromotingToAdapter(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="border-b pb-3 text-xs font-mono text-muted-foreground">{conversationKey}</div>

      <div className="border-b pb-5">
        <ConversationBehaviorEditor
          scope="conversation"
          value={{
            mode: mode === "unset" ? undefined : mode,
            inboundActivationPolicy: activationPolicy === "inherit" ? undefined : activationPolicy,
            activeRunDispatchMode: dispatchMode === "inherit" ? undefined : dispatchMode,
            activationTtlHours,
          }}
          sources={effectiveSources}
          onChange={(next) => {
            setMode(next.mode ?? "unset")
            setActivationPolicy(next.inboundActivationPolicy ?? "inherit")
            setDispatchMode(next.activeRunDispatchMode ?? "inherit")
            setActivationTtlHours(next.activationTtlHours ?? "")
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-character-state">{t("fields.character")}</Label>
        <Select
          value={characterState}
          onValueChange={(value) => setCharacterState(value as typeof characterState)}
        >
          <SelectTrigger
            id="conv-override-character-state"
            data-testid="conv-override-character-state"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t("fields.target.inherit")}</SelectItem>
            <SelectItem value="none">{t("fields.target.none")}</SelectItem>
            <SelectItem value="character">{t("fields.target.specificCharacter")}</SelectItem>
          </SelectContent>
        </Select>
        {characterState === "character" && (
          <EntityPicker
            id="conv-override-character"
            value={characterId}
            items={(characters ?? []).map((character) => ({
              id: character.id,
              label: character.name,
            }))}
            emptyLabel={t("fields.characterPlaceholder")}
            missingLabel={(id) => t("fields.referenceMissing", { id })}
            onChange={(id) => setCharacterId(id ?? "")}
            triggerTestId="conv-override-character"
          />
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-target">{t("fields.target.label")}</Label>
        <Select
          value={targetKind}
          onValueChange={(value) => setTargetKind(value as typeof targetKind)}
        >
          <SelectTrigger id="conv-override-target" data-testid="conv-override-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t("fields.target.inherit")}</SelectItem>
            <SelectItem value="direct">{t("fields.target.direct")}</SelectItem>
            <SelectItem value="team">{t("fields.target.team")}</SelectItem>
            <SelectItem value="workflow">{t("fields.target.workflow")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {targetKind === "team" && (
        <div className="space-y-2">
          <Label htmlFor="conv-override-team">{t("fields.teamBinding")}</Label>
          <TeamPicker
            id="conv-override-team"
            value={teamId}
            onChange={(id) => setTeamId(id ?? "")}
          />
          <p className="text-[11px] text-muted-foreground">{t("fields.teamBindingHelp")}</p>
        </div>
      )}

      {targetKind === "workflow" && (
        <div className="space-y-2">
          <Label htmlFor="conv-override-workflow">{t("fields.workflowBinding")}</Label>
          <EntityPicker
            id="conv-override-workflow"
            value={workflowId}
            items={(executableWorkflows ?? []).map((workflow) => ({
              id: workflow.id,
              label: workflow.name,
              description: t("fields.workflowProduction"),
            }))}
            emptyLabel={t("fields.workflowBindingPlaceholder")}
            missingLabel={(id) => t("fields.referenceMissing", { id })}
            onChange={(id) => setWorkflowId(id ?? "")}
            triggerTestId="conv-override-workflow"
          />
          <p className="text-[11px] text-muted-foreground">{t("fields.workflowBindingHelp")}</p>
        </div>
      )}

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
        {targetKind === "team" ||
        targetKind === "workflow" ||
        (targetKind === "inherit" && effectiveTargetKind && effectiveTargetKind !== "direct") ? (
          <p className="text-xs text-muted-foreground" data-testid="conv-override-model-managed">
            {t("fields.modelManagedByTarget")}
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="conv-override-provider-model">
              {t("fields.providerModelOverride")}
            </Label>
            <EntityPicker
              id="conv-override-provider-model"
              value={
                providerOverride || modelOverride
                  ? `${providerOverride}:${modelOverride}`
                  : undefined
              }
              items={providerModelOptions.map((option) => ({
                id: `${option.providerId}:${option.modelId}`,
                label: option.label,
              }))}
              emptyLabel={t("fields.providerModelDefault")}
              missingLabel={(id) => t("fields.referenceMissing", { id })}
              onChange={(value) => {
                if (!value) {
                  setProviderOverride("")
                  setModelOverride("")
                  return
                }
                const separator = value.indexOf(":")
                setProviderOverride(value.slice(0, separator))
                setModelOverride(value.slice(separator + 1))
              }}
              triggerTestId="conv-override-provider-model"
            />
          </div>
        )}
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

      {/* SLA escalation chain (slice 1B): per-conversation override of the
       * bot-wide `defaultEscalation`; `undefined` inherits. */}
      <div className="space-y-2 border-b pb-5" data-testid="conv-override-escalation">
        <Label>{t("escalation.title")}</Label>
        <p className="text-xs text-muted-foreground">{t("escalation.sectionHint")}</p>
        <EscalationPolicyEditor
          scope="conversation"
          platform={platform}
          value={escalation}
          onChange={setEscalation}
          characters={(characters ?? []).map((c) => ({ id: c.id, name: c.name }))}
          disabled={saving}
          idPrefix="conv-override-escalation"
        />
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

      {/* Reply quoting opt-OUT (ADR-0009 §3A.3). DEFAULT ON — group / thread
       * ai-run replies quote the triggering message on platforms that declare
       * `send.reply`. Flip OFF to send un-quoted replies in this conversation. */}
      <div className="flex items-start gap-3 border-b pb-5">
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="conv-override-reply-quoting" className="cursor-pointer">
              {t("fields.replyQuoting")}
            </Label>
            <Switch
              id="conv-override-reply-quoting"
              checked={replyQuoting}
              onCheckedChange={setReplyQuoting}
              data-testid="conv-override-reply-quoting"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("fields.replyQuotingHint")}</p>
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
                placeholder={t("fields.quietHours.tzPlaceholder")}
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
            onClick={onPromoteToAdapter}
            disabled={promotingToAdapter || saving || !adapterId}
            data-testid="conv-override-promote-to-adapter"
            title={t("fields.promoteToAdapterTitle")}
          >
            {promotingToAdapter ? t("saving") : t("fields.promoteToAdapter")}
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
