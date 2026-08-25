"use client"

// Settings → Conversation → Input & sending: how the composer's thinking-level
// control behaves before a conversation exists.
//
// Two preferences live here, and neither belongs on the per-session control
// itself — both are answers a user gives once:
//
//   - the tier every NEW session starts on (`AppSettings.defaultThinkingLevel`),
//     stamped by `lib/db/sessions.ts:createSession`. Without it the depth choice
//     resets with every conversation, which is the wrong default for anyone who
//     works at one depth all day; and
//   - which tiers the control offers at all
//     (`composerBehavior.hiddenEffortTiers`). Six stops is a lot of track for
//     someone who uses three, and a shorter ladder is a control you aim at
//     rather than drag past.
//
// Hiding is presentation only — see `lib/ai/thinking-level.ts`. A session
// already on a hidden tier keeps running at that depth; the control just folds
// its DISPLAY to the nearest visible tier. That is why this card can be a
// preference rather than a migration.
//
// The presentation switch (slider vs list) stays in `./composer-behavior-card`
// with the other composer toggles: it describes the widget, not the ladder.

import { useTranslations } from "next-intl"
import { CheckIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { cn } from "@/lib/utils"
import {
  EFFORT_SLIDER_LEVELS,
  THINKING_LEVELS,
  type EffortTier,
  type ThinkingLevel,
} from "@/lib/ai/thinking-level"
import type { AppSettings } from "@cognia/agent-config-types"

type ComposerBehavior = NonNullable<AppSettings["composerBehavior"]>

export function EffortPreferencesCard() {
  const t = useTranslations("settings.conversation.effortPreferences")
  const tLevel = useTranslations("chat.composer.effort.level")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const cb: ComposerBehavior = settings?.composerBehavior ?? {}
  const hidden = cb.hiddenEffortTiers ?? []
  // No stored default means "leave new sessions alone", which is exactly what
  // the `off` tier already names — so the two collapse onto one choice rather
  // than making the user distinguish "unset" from "explicitly auto".
  const defaultLevel: ThinkingLevel = settings?.defaultThinkingLevel ?? "off"

  const setDefaultLevel = (level: ThinkingLevel) => {
    // `off` round-trips as a stored value, not as `undefined`: a user who
    // deliberately turned the default off should not be re-defaulted by a later
    // change to what "unset" means.
    void save({ defaultThinkingLevel: level })
  }

  const toggleTier = (tier: EffortTier) => {
    const next = hidden.includes(tier) ? hidden.filter((t) => t !== tier) : [...hidden, tier]
    // Hiding every tier would leave the control with nothing to offer, and
    // `visibleThinkingLevels` deliberately ignores such a preference rather
    // than unmounting the only surface that can undo it. Refusing the last
    // un-hide here keeps the stored value honest about what the user will see.
    if (next.length >= EFFORT_SLIDER_LEVELS.length) return
    void save({ composerBehavior: { ...cb, hiddenEffortTiers: next } })
  }

  return (
    <div className="space-y-4" data-testid="effort-preferences-card">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="effort-default-level" className="text-sm">
            {t("defaultLevel.label")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("defaultLevel.hint")}</p>
        </div>
        <Select value={defaultLevel} onValueChange={(v) => setDefaultLevel(v as ThinkingLevel)}>
          <SelectTrigger
            id="effort-default-level"
            className="w-[9.5rem] shrink-0"
            aria-label={t("defaultLevel.label")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THINKING_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {tLevel(level as "off")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label className="text-sm">{t("visibleTiers.label")}</Label>
          <p className="text-xs text-muted-foreground">{t("visibleTiers.hint")}</p>
        </div>
        {/* Toggle chips rather than a row of switches: the set is small, the
            choice is "which of these", and the shape mirrors the ladder the
            composer draws. */}
        <div role="group" aria-label={t("visibleTiers.label")} className="flex flex-wrap gap-1.5">
          {EFFORT_SLIDER_LEVELS.map((tier) => {
            const visible = !hidden.includes(tier)
            const ultra = tier === "ultracode"
            return (
              <button
                key={tier}
                type="button"
                role="checkbox"
                aria-checked={visible}
                onClick={() => toggleTier(tier)}
                data-testid={`effort-tier-toggle-${tier}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 text-xs",
                  // Same motion vocabulary as the composer's ladder: the press
                  // gives, the check pops in, and the top tier glows because it
                  // is a change in kind rather than one more notch.
                  "transition-[color,background-color,border-color,box-shadow,scale] duration-200 active:scale-[0.97]",
                  visible
                    ? ultra
                      ? "border-effort-ultra/40 bg-effort-ultra-muted text-effort-ultra shadow-[0_0_12px_-4px_var(--effort-ultra)]"
                      : "border-transparent bg-accent text-accent-foreground"
                    : "border-dashed border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {/* Keyed by state so the pop re-fires on every toggle. */}
                <CheckIcon
                  key={visible ? "on" : "off"}
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0",
                    visible ? "effort-glyph-pulse opacity-100" : "opacity-0"
                  )}
                />
                {tLevel(tier as "off")}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
