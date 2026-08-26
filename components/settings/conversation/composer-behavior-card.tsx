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
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatLinkRules, parseLinkRules, type LinkDisplayStyle } from "@/lib/chat/link-display"
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
  // Link-chip presentation. `short` is the default shape; the rule list is
  // edited as text (one per line) because that is how people think about a
  // list of hosts, and it round-trips through `parseLinkRules`.
  const linkChips = cb.linkChips ?? {}
  const linkStyle: LinkDisplayStyle = linkChips.style ?? "short"
  const rulesText = formatLinkRules(linkChips.rules ?? [])

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

      {/* Link chips: presentation only. Nothing here changes which links get
          read at send time — see `lib/chat/link-display.ts`. */}
      <div className="space-y-3 border-t pt-4">
        <div className="space-y-0.5">
          <Label className="text-sm">{t("linkChips.label")}</Label>
          <p className="text-xs text-muted-foreground">{t("linkChips.hint")}</p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="composer-link-style" className="text-sm font-normal">
            {t("linkChips.styleLabel")}
          </Label>
          <Select
            value={linkStyle}
            onValueChange={(next) =>
              update({ linkChips: { ...linkChips, style: next as LinkDisplayStyle } })
            }
          >
            <SelectTrigger
              id="composer-link-style"
              className="w-64"
              aria-label={t("linkChips.styleLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="short">{t("linkChips.styleShort")}</SelectItem>
              <SelectItem value="host">{t("linkChips.styleHost")}</SelectItem>
              <SelectItem value="full">{t("linkChips.styleFull")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="composer-link-rules" className="text-sm font-normal">
            {t("linkChips.rulesLabel")}
          </Label>
          {/*
            Uncontrolled, keyed by the saved text and committed on blur: rules
            are only well-formed between keystrokes, so parsing on every one
            would delete a host the moment the user typed the `=` after it.
            The key re-seeds the field if the value changes elsewhere (another
            device syncing this shared setting).
          */}
          <Textarea
            id="composer-link-rules"
            key={rulesText}
            defaultValue={rulesText}
            rows={3}
            spellCheck={false}
            placeholder={t("linkChips.rulesPlaceholder")}
            aria-label={t("linkChips.rulesLabel")}
            className="font-mono text-xs"
            onBlur={(event) => {
              const next = parseLinkRules(event.currentTarget.value)
              if (formatLinkRules(next) === rulesText) return
              update({ linkChips: { ...linkChips, rules: next } })
            }}
          />
          <p className="text-xs text-muted-foreground">{t("linkChips.rulesHint")}</p>
        </div>
      </div>
    </div>
  )
}
