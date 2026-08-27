"use client"

// Settings card for the composer's LLM input assistance (prompt enhancement,
// inline ghost-text autocomplete, AI starter / follow-up suggestions). Mirrors
// the terminal autocomplete card: reads/writes the optional
// `AppSettings.composerAssistance` block through the settings store `save`.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  ModelOverrideFields,
  useUtilityProviderOptions,
} from "@/components/settings/common/model-override-fields"
import type { AppSettings } from "@cognia/agent-config-types"

type ComposerAssistance = NonNullable<AppSettings["composerAssistance"]>

const MIN_DEBOUNCE = 200
const MAX_DEBOUNCE = 2000
const DEFAULT_DEBOUNCE = 500

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
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

export function ComposerAssistanceCard() {
  const t = useTranslations("settings.composerAssistance")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const ca: ComposerAssistance = settings?.composerAssistance ?? {}
  const enhanceEnabled = ca.enhance?.enabled !== false
  // Two independent ghost-text tiers: the local one is free (opt-out), the
  // model one bills per keystroke burst (opt-in). See `ghostText` in the
  // AppSettings docs and `lib/chat/completion/inline/engine.ts`.
  const ghostLocalEnabled = ca.ghostText?.local !== false
  const ghostEnabled = !!ca.ghostText?.enabled
  const debounceMs = ca.ghostText?.debounceMs ?? DEFAULT_DEBOUNCE
  const startersEnabled = ca.suggestions?.starters !== false
  const followUpsEnabled = ca.suggestions?.followUps !== false
  const providers = useUtilityProviderOptions()

  function update(patch: Partial<ComposerAssistance>): void {
    void save({ composerAssistance: { ...ca, ...patch } })
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <ToggleRow
        id="composer-enhance"
        label={t("enhance.label")}
        hint={t("enhance.hint")}
        checked={enhanceEnabled}
        onChange={(next) => update({ enhance: { enabled: next } })}
      />

      <ToggleRow
        id="composer-ghost-local"
        label={t("ghostTextLocal.label")}
        hint={t("ghostTextLocal.hint")}
        checked={ghostLocalEnabled}
        onChange={(next) => update({ ghostText: { ...ca.ghostText, local: next } })}
      />

      <ToggleRow
        id="composer-ghost"
        label={t("ghostText.label")}
        hint={t("ghostText.hint")}
        checked={ghostEnabled}
        onChange={(next) => update({ ghostText: { ...ca.ghostText, enabled: next } })}
      />

      {ghostEnabled ? (
        <div className="space-y-1 pl-1">
          <Label htmlFor="composer-ghost-debounce" className="text-xs">
            {t("ghostText.debounceLabel")}
          </Label>
          <Input
            id="composer-ghost-debounce"
            type="number"
            min={MIN_DEBOUNCE}
            max={MAX_DEBOUNCE}
            step={50}
            value={debounceMs}
            onChange={(e) => {
              const raw = Number(e.target.value)
              const clamped = Number.isFinite(raw)
                ? Math.min(MAX_DEBOUNCE, Math.max(MIN_DEBOUNCE, raw))
                : DEFAULT_DEBOUNCE
              update({ ghostText: { ...ca.ghostText, enabled: true, debounceMs: clamped } })
            }}
            className="h-8 w-28 text-xs"
            aria-label={t("ghostText.debounceLabel")}
          />
        </div>
      ) : null}

      <ToggleRow
        id="composer-starters"
        label={t("starters.label")}
        hint={t("starters.hint")}
        checked={startersEnabled}
        onChange={(next) => update({ suggestions: { ...ca.suggestions, starters: next } })}
      />

      <ToggleRow
        id="composer-followups"
        label={t("followUps.label")}
        hint={t("followUps.hint")}
        checked={followUpsEnabled}
        onChange={(next) => update({ suggestions: { ...ca.suggestions, followUps: next } })}
      />

      {/* `composerAssistance.model` was readable by all four helpers above and
          writable by nobody — the one knob that lets them run on a provider
          the renderer actually holds a key for. Same fields the conversation
          title / timeline label configs use, so the utility overrides all
          present alike. */}
      <div className="space-y-3 border-t pt-4">
        <div className="space-y-0.5">
          <Label className="text-sm">{t("assistanceModel.heading")}</Label>
          <p className="text-xs text-muted-foreground">{t("assistanceModel.description")}</p>
        </div>
        <ModelOverrideFields
          value={ca.model}
          providers={providers}
          onChange={(patch) => update({ model: { ...ca.model, ...patch } })}
          labels={{
            provider: t("assistanceModel.provider"),
            model: t("assistanceModel.model"),
            useDefault: t("assistanceModel.useDefault"),
          }}
        />
      </div>
    </div>
  )
}
