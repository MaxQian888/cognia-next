"use client"

// Settings → Conversation: non-LLM composer / send-box behavior toggles.
// Reads/writes the optional `AppSettings.composerBehavior` block through the
// settings store `save`. Every switch defaults ON (`!== false`) so an absent
// block leaves the historical hard-coded behavior unchanged. Mirrors the
// composer-assistance card's borderless ToggleRow (explicit aria-label) so the
// two groups read as one inside the "Input & send" card.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_COMPOSER_SKIN } from "@/lib/chat/composer-skin"
import { DEFAULT_EFFORT_SELECTOR_MODE } from "@/components/chat/composer/effort-selector-view"
import type { AppSettings } from "@cognia/agent-config-types"

type ComposerBehavior = NonNullable<AppSettings["composerBehavior"]>

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
  /** Rendered inert with this reason in place of the usual hint. */
  disabled?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", disabled && "opacity-60")}>
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{disabled ?? hint}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        disabled={Boolean(disabled)}
      />
    </div>
  )
}

export function ComposerBehaviorCard() {
  const t = useTranslations("settings.conversation.composerBehavior")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const cb: ComposerBehavior = settings?.composerBehavior ?? {}
  const compactLayout = cb.compactLayout === true
  // A non-classic skin decides the layout itself; see the row below.
  const skinOwnsLayout = (cb.skin ?? DEFAULT_COMPOSER_SKIN) !== "classic"
  const sendOnEnter = cb.sendOnEnter !== false
  const clearAfterSend = cb.clearAfterSend !== false
  const autoScrollOnStream = cb.autoScrollOnStream !== false
  const inputHistoryRecall = cb.inputHistoryRecall !== false
  const persistDrafts = cb.persistDrafts !== false
  // The one non-boolean member of this block: a two-way presentation choice for
  // the composer's thinking-level control, surfaced as a switch because there
  // are exactly two modes. `"slider"` is the default (see
  // `components/chat/composer/effort-selector-view.ts`), so an absent value
  // reads as on.
  const effortSliderMode = (cb.effortSelectorMode ?? DEFAULT_EFFORT_SELECTOR_MODE) === "slider"

  function update(patch: Partial<ComposerBehavior>): void {
    void save({ composerBehavior: { ...cb, ...patch } })
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {/* Intentional dormancy, labelled where the user would otherwise reach
          for it: under any non-classic skin the skin owns the box geometry and
          the toolbar placement, so this flag has nothing left to decide.
          `resolveComposerSkin` ignores it and `composer-skin.test.ts` pins
          that. */}
      <ToggleRow
        id="composer-compact-layout"
        label={t("compactLayout.label")}
        hint={t("compactLayout.hint")}
        checked={compactLayout}
        onChange={(next) => update({ compactLayout: next })}
        disabled={skinOwnsLayout ? t("compactLayout.supersededBySkin") : undefined}
      />

      <ToggleRow
        id="composer-send-on-enter"
        label={t("sendOnEnter.label")}
        hint={t("sendOnEnter.hint")}
        checked={sendOnEnter}
        onChange={(next) => update({ sendOnEnter: next })}
      />

      <ToggleRow
        id="composer-clear-after-send"
        label={t("clearAfterSend.label")}
        hint={t("clearAfterSend.hint")}
        checked={clearAfterSend}
        onChange={(next) => update({ clearAfterSend: next })}
      />

      <ToggleRow
        id="composer-auto-scroll"
        label={t("autoScroll.label")}
        hint={t("autoScroll.hint")}
        checked={autoScrollOnStream}
        onChange={(next) => update({ autoScrollOnStream: next })}
      />

      <ToggleRow
        id="composer-input-history"
        label={t("inputHistory.label")}
        hint={t("inputHistory.hint")}
        checked={inputHistoryRecall}
        onChange={(next) => update({ inputHistoryRecall: next })}
      />

      <ToggleRow
        id="composer-persist-drafts"
        label={t("persistDrafts.label")}
        hint={t("persistDrafts.hint")}
        checked={persistDrafts}
        onChange={(next) => update({ persistDrafts: next })}
      />

      <ToggleRow
        id="composer-effort-selector-mode"
        label={t("effortSelectorMode.label")}
        hint={t("effortSelectorMode.hint")}
        checked={effortSliderMode}
        onChange={(next) => update({ effortSelectorMode: next ? "slider" : "list" })}
      />
    </div>
  )
}
