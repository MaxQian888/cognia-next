"use client"

/**
 * Mobile Agent defaults page (ADR-0056, Wave 1). Exposes the agent-default
 * preferences that already sync desktop→phone but were not editable from the
 * phone: permission mode, default system prompt, thinking budget, and the
 * bare/brief/debug behavior toggles.
 *
 * These only have a real backend when paired (the standalone BYOK engine runs
 * no agent loop / permission modes — decision D2), so the body is wrapped in
 * `<PairedOnly>`. Raising the permission mode toward a more autonomous setting
 * is biometric-gated (decision D4) via `useBiometricGuard` +
 * `isPermissionModeEscalation`.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { BiometricRow } from "@/components/mobile/me/biometric-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"
import {
  isPermissionModeEscalation,
  type PermissionMode,
} from "@/lib/settings/permission-mode-escalation"
import { useSettingsStore } from "@/stores/settings"

const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]

const PERMISSION_MODE_LABEL_KEY: Record<PermissionMode, string> = {
  default: "permDefault",
  acceptEdits: "permAcceptEdits",
  bypassPermissions: "permBypass",
  plan: "permPlan",
  dontAsk: "permDontAsk",
  auto: "permAuto",
}

const THINKING_MIN = 0
const THINKING_MAX = 64000
const THINKING_STEP = 1024

function MobileAgentBody() {
  const t = useTranslations("mobile.agent")
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsPatch()
  const guard = useBiometricGuard()

  const permissionMode = (settings?.permissionMode ?? "default") as PermissionMode
  const policy = settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD
  const bareMode = Boolean(settings?.bareMode)
  const briefMode = Boolean(settings?.briefMode)
  const debugMode = Boolean(settings?.debugMode)
  const compaction = settings?.compaction ?? {}
  // Auto-compaction defaults ON when unset.
  const compactionEnabled = compaction.enabled !== false
  // Surface-skill auto-injection defaults ON (only explicit false disables).
  const surfaceSkillsEnabled = settings?.surfaceSkillsEnabled !== false

  const [systemPrompt, setSystemPrompt] = useState(settings?.defaultSystemPrompt ?? "")
  const [thinking, setThinking] = useState<number>(settings?.defaultMaxThinkingTokens ?? 0)

  // Mirror external settings changes (first load / desktop sync-down) into the
  // local input state so blur-persist works without flicker.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setSystemPrompt(settings?.defaultSystemPrompt ?? "")
    setThinking(settings?.defaultMaxThinkingTokens ?? 0)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings?.defaultSystemPrompt, settings?.defaultMaxThinkingTokens])

  const onPermissionMode = async (next: string) => {
    if (!PERMISSION_MODES.includes(next as PermissionMode)) return
    const target = next as PermissionMode
    const gated =
      (policy.escalatePermissionMode ?? true) && isPermissionModeEscalation(permissionMode, target)
    if (gated) {
      // Only writes on a verified biometric; a blocked/cancelled gate leaves
      // the persisted value untouched and the Select reverts on re-render.
      await guard({ reason: t("escalateReason"), title: t("escalateTitle") }, () =>
        update({ permissionMode: target })
      )
      return
    }
    await update({ permissionMode: target })
  }

  const persistSystemPrompt = () => {
    const trimmed = systemPrompt.trim()
    void update({ defaultSystemPrompt: trimmed || undefined })
  }

  const persistThinking = (raw: number) => {
    const clamped = Math.max(
      THINKING_MIN,
      Math.min(THINKING_MAX, Number.isFinite(raw) ? Math.round(raw) : 0)
    )
    setThinking(clamped)
    void update({ defaultMaxThinkingTokens: clamped > 0 ? clamped : undefined })
  }

  return (
    <div className="flex flex-col gap-4">
      <MeSection
        title={t("permissionSection")}
        description={t("permissionDesc")}
        testid="me-section-agent-permission"
      >
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="text-xs">{t("permissionMode")}</ItemTitle>
            <Select value={permissionMode} onValueChange={(v) => void onPermissionMode(v)}>
              <SelectTrigger
                data-testid="agent-permission-mode"
                aria-label={t("permissionMode")}
                className="mt-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(PERMISSION_MODE_LABEL_KEY[m])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ItemContent>
        </Item>
        <BiometricRow
          label={t("escalateGate")}
          help={t("escalateGateHelp")}
          checked={policy.escalatePermissionMode ?? true}
          onChange={(v) =>
            void update({ biometricRequiredFor: { ...policy, escalatePermissionMode: v } })
          }
          testid="agent-escalate-gate"
        />
      </MeSection>

      <MeSection
        title={t("promptSection")}
        description={t("promptHelp")}
        testid="me-section-agent-prompt"
      >
        <Item size="sm" className="px-0">
          <ItemContent>
            <Label htmlFor="agent-system-prompt" className="text-xs">
              {t("systemPrompt")}
            </Label>
            <Textarea
              id="agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              onBlur={persistSystemPrompt}
              rows={4}
              placeholder={t("promptPlaceholder")}
              data-testid="agent-system-prompt"
              className="mt-1"
            />
          </ItemContent>
        </Item>
      </MeSection>

      <MeSection
        title={t("thinkingSection")}
        description={t("thinkingHelp")}
        testid="me-section-agent-thinking"
      >
        <Item size="sm" className="px-0">
          <ItemContent>
            <div className="flex items-center gap-2">
              <Slider
                className="flex-1"
                value={[thinking]}
                min={THINKING_MIN}
                max={THINKING_MAX}
                step={THINKING_STEP}
                onValueChange={(v) => setThinking(v[0] ?? 0)}
                onValueCommit={(v) => persistThinking(v[0] ?? 0)}
                aria-label={t("thinkingSection")}
                data-testid="agent-thinking-slider"
              />
              <Input
                type="number"
                inputMode="numeric"
                min={THINKING_MIN}
                max={THINKING_MAX}
                step={THINKING_STEP}
                className="w-24"
                value={thinking}
                onChange={(e) => setThinking(Number(e.target.value) || 0)}
                onBlur={() => persistThinking(thinking)}
                aria-label={t("thinkingNumberLabel")}
                data-testid="agent-thinking-input"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => persistThinking(0)}
                disabled={thinking === 0}
                data-testid="agent-thinking-reset"
              >
                {t("thinkingReset")}
              </Button>
            </div>
            <ItemDescription className="mt-1 text-[11px]">
              {thinking > 0
                ? t("thinkingActiveHint", { budget: thinking })
                : t("thinkingDisabledHint")}
            </ItemDescription>
          </ItemContent>
        </Item>
      </MeSection>

      <MeSection title={t("behaviorSection")} testid="me-section-agent-behavior">
        <BiometricRow
          label={t("bareMode")}
          help={t("bareModeHelp")}
          checked={bareMode}
          onChange={(v) => void update({ bareMode: v || undefined })}
          testid="agent-bare-mode"
        />
        <BiometricRow
          label={t("briefMode")}
          help={t("briefModeHelp")}
          checked={briefMode}
          onChange={(v) => void update({ briefMode: v || undefined })}
          testid="agent-brief-mode"
        />
        <BiometricRow
          label={t("debugMode")}
          help={t("debugModeHelp")}
          checked={debugMode}
          onChange={(v) => void update({ debugMode: v || undefined })}
          testid="agent-debug-mode"
        />
        <BiometricRow
          label={t("surfaceSkills")}
          help={t("surfaceSkillsHelp")}
          checked={surfaceSkillsEnabled}
          onChange={(v) => void update({ surfaceSkillsEnabled: v })}
          testid="agent-surface-skills"
        />
      </MeSection>

      <MeSection
        title={t("compactionSection")}
        description={t("compactionHelp")}
        testid="me-section-agent-compaction"
      >
        <BiometricRow
          label={t("compactionEnabled")}
          help={t("compactionEnabledHelp")}
          checked={compactionEnabled}
          onChange={(v) => void update({ compaction: { ...compaction, enabled: v } })}
          testid="agent-compaction-enabled"
        />
      </MeSection>
    </div>
  )
}

export default function MobileAgentPage() {
  const t = useTranslations("mobile.agent")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-agent-page">
      <PairedOnly>
        <MobileAgentBody />
      </PairedOnly>
    </SubPageShell>
  )
}
