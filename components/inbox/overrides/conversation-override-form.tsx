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
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConnectorMode } from "@/types/connectors/policy"

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
  const [characterId, setCharacterId] = useState(initialRow?.characterId ?? "")
  const [allowComputerUse, setAllowComputerUse] = useState(initialRow?.allowComputerUse ?? false)
  const [providerOverride, setProviderOverride] = useState(initialRow?.providerOverride ?? "")
  const [modelOverride, setModelOverride] = useState(initialRow?.modelOverride ?? "")
  const [pinned, setPinned] = useState(initialRow?.pinned ?? false)
  const [archived, setArchived] = useState(initialRow?.archived ?? false)
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
        characterId: characterId.trim() || undefined,
        allowComputerUse: allowComputerUse ? true : undefined,
        providerOverride: providerOverride.trim() || undefined,
        modelOverride: modelOverride.trim() || undefined,
        pinned: pinned ? true : undefined,
        archived: archived ? true : undefined,
        trigger: initialRow?.trigger,
        allowedBuiltInSkillIds: resolvedAllowed,
        // The HITL flag defaults true at the read site; only persist when
        // explicitly set to false so older rows don't get migration churn.
        requireHitlForWrites: requireHitlForWrites === false ? false : undefined,
        quietHours: resolvedQuietHours,
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

  // Suppress lint warning about adapterId being unused — it's part of
  // the public prop contract for parent components that mount the form
  // by adapter scope, and the audit log on the bus side keys on this.
  void adapterId

  return (
    <div className="space-y-5">
      <div className="rounded-md bg-muted/30 px-3 py-2 text-xs font-mono text-muted-foreground">
        {conversationKey}
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-mode">{t("fields.mode")}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as ConnectorMode | "unset")}>
          <SelectTrigger id="conv-override-mode" data-testid="conv-override-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {t(`fields.modeOptions.${m.key}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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

      <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
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
      </div>

      <div className="grid grid-cols-2 gap-3">
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

      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
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
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
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

      {/* Quiet hours — per-conversation override that beats the adapter
       * default in `outbound-runner`. */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
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
          <div className="grid grid-cols-3 gap-2">
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
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
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
                    <button
                      type="button"
                      onClick={() => removeSkill(id)}
                      aria-label={t("fields.allowedSkills.remove", { id })}
                      data-testid={`conv-override-skills-remove-${id}`}
                      className="rounded-sm p-0.5 hover:bg-muted"
                    >
                      <XIcon className="h-2.5 w-2.5" aria-hidden />
                    </button>
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
      <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-start gap-2">
          <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
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
        </div>
      </div>

      <div
        className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-xs text-muted-foreground dark:border-amber-800 dark:bg-amber-950/20"
        data-testid="conv-override-quiet-hours-notice"
      >
        <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t("fields.advancedJsonHelp")}</span>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2">
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
        <div className="flex items-center gap-2">
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
