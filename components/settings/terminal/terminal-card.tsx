"use client"

/**
 * Settings card for the integrated terminal dock.
 *
 * Modeled on `components/settings/appearance/components/density-card.tsx`:
 *   * reads / writes via `useSettingsStore()`,
 *   * one-line label + control pattern,
 *   * `save({ terminal: {...} })` debounces persistence in the store.
 *
 * Covers v1 scope:
 *   * default shell (auto / bash / zsh / pwsh / explicit path),
 *   * font family + size, scrollback,
 *   * enable-shell-integration toggle,
 *   * per-project override panel that mutates `useProjectStore`.
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { AUTO_SCHEME_ID, TERMINAL_COLOR_SCHEMES } from "@/lib/terminal/color-schemes"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"

import { FontFamilyPicker } from "@/components/settings/appearance/components/font-family-picker"
import { TerminalProfiles } from "./terminal-profiles"
import { TerminalProjectOverride } from "./terminal-project-override"

type TerminalSettings = NonNullable<
  NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]>["terminal"]
>

const DEFAULT_VALUES: TerminalSettings = {
  defaultShell: "",
  fontFamily: "",
  fontSize: 13,
  scrollback: 10000,
  enableShellIntegration: true,
  copyOnSelect: false,
  exposeDockToAgents: false,
  runInDockTimeoutSec: 60,
  cursorStyle: "block",
  cursorBlink: true,
  fontLigatures: false,
  forceUtf8: true,
  colorScheme: AUTO_SCHEME_ID,
  renderer: "auto",
  autocomplete: {
    enabled: false,
    source: "both",
    debounceMs: 350,
    path: true,
    exe: true,
    spec: true,
    persistHistory: true,
    popup: true,
  },
  allowUnattendedExecution: false,
  unattendedAskPolicy: "fail",
}

const ASK_POLICIES: ReadonlyArray<"fail" | "consent" | "run"> = ["fail", "consent", "run"]

const AUTOCOMPLETE_SOURCES: ReadonlyArray<"both" | "ai" | "history"> = ["both", "ai", "history"]

const RENDERERS: ReadonlyArray<"auto" | "webgl" | "canvas" | "dom"> = [
  "auto",
  "webgl",
  "canvas",
  "dom",
]

/**
 * Recommended font stack for oh-my-posh / powerline prompts. The leading
 * Nerd Font carries the glyphs; the rest are plain-coding-font fallbacks the
 * machine is likely to already have. The user must install a Nerd Font for
 * the icons to render — we can only point the font-family at one.
 */
const NERD_FONT_STACK = '"CaskaydiaCove Nerd Font", "JetBrains Mono", "Cascadia Code", monospace'

const CURSOR_STYLES: ReadonlyArray<"block" | "bar" | "underline"> = ["block", "bar", "underline"]

const AUTO = "__auto__"
const CUSTOM = "__custom__"

const SHELL_PRESETS: Array<{ value: string; labelKey: string }> = [
  { value: AUTO, labelKey: "settings.terminal.shell.auto" },
  { value: "/bin/bash", labelKey: "settings.terminal.shell.bash" },
  { value: "/bin/zsh", labelKey: "settings.terminal.shell.zsh" },
  { value: "pwsh.exe", labelKey: "settings.terminal.shell.pwsh" },
  { value: "powershell.exe", labelKey: "settings.terminal.shell.powershell" },
  { value: "cmd.exe", labelKey: "settings.terminal.shell.cmd" },
  { value: CUSTOM, labelKey: "settings.terminal.shell.custom" },
]

export function TerminalCard() {
  const t = useTranslations()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const terminal: TerminalSettings = {
    ...DEFAULT_VALUES,
    ...(settings?.terminal ?? {}),
  }
  const autocomplete = terminal.autocomplete ?? DEFAULT_VALUES.autocomplete!

  function update(patch: Partial<TerminalSettings>): void {
    void save({ terminal: { ...terminal, ...patch } })
  }

  const currentShellValue = !terminal.defaultShell
    ? AUTO
    : SHELL_PRESETS.find(
          (p) => p.value === terminal.defaultShell && p.value !== AUTO && p.value !== CUSTOM
        )
      ? terminal.defaultShell
      : CUSTOM

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label className="text-xs">{t("settings.terminal.shell.label")}</Label>
        <Select
          value={currentShellValue}
          onValueChange={(value) => {
            if (value === AUTO) {
              update({ defaultShell: "" })
            } else if (value === CUSTOM) {
              if (!terminal.defaultShell) update({ defaultShell: "/bin/sh" })
            } else {
              update({ defaultShell: value })
            }
          }}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={t("settings.terminal.shell.auto")} />
          </SelectTrigger>
          <SelectContent>
            {SHELL_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value} className="text-xs">
                {t(p.labelKey as never)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {currentShellValue === CUSTOM ? (
          <Input
            value={terminal.defaultShell ?? ""}
            placeholder="/usr/local/bin/fish"
            onChange={(e) => update({ defaultShell: e.target.value })}
            className="h-8 text-xs"
            aria-label={t("settings.terminal.shell.customLabel")}
          />
        ) : null}
        <p className="text-[11px] text-muted-foreground">{t("settings.terminal.shell.helper")}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">{t("settings.terminal.fontFamily.label")}</Label>
          {/* Quick-pick from monospace fonts detected on this device. Writes
              into the same `fontFamily` value as the text input below, which
              stays for custom stacks / the Nerd Font preset. */}
          <FontFamilyPicker
            namespace="settings.terminal.fontFamily"
            labelKey="pickerLabel"
            hintKey="pickerHint"
            monoOnly
            value={terminal.fontFamily || undefined}
            onChange={(next) => update({ fontFamily: next ?? "" })}
          />
          <Input
            value={terminal.fontFamily ?? ""}
            placeholder='"JetBrains Mono", monospace'
            onChange={(e) => update({ fontFamily: e.target.value })}
            className="h-8 text-xs"
            aria-label={t("settings.terminal.fontFamily.label")}
            data-testid="terminal-card-font-family"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">{t("settings.terminal.fontSize.label")}</Label>
          <Input
            type="number"
            min={8}
            max={32}
            value={terminal.fontSize ?? DEFAULT_VALUES.fontSize}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) update({ fontSize: Math.max(8, Math.min(32, n)) })
            }}
            className="h-8 text-xs"
            aria-label={t("settings.terminal.fontSize.label")}
            data-testid="terminal-card-font-size"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] text-muted-foreground">
          {t("settings.terminal.fontFamily.nerdFontHelper")}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => update({ fontFamily: NERD_FONT_STACK })}
          data-testid="terminal-card-use-nerd-font"
        >
          {t("settings.terminal.fontFamily.useNerdFont")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">{t("settings.terminal.cursor.label")}</Label>
          <Select
            value={terminal.cursorStyle ?? "block"}
            onValueChange={(value) =>
              update({ cursorStyle: value as "block" | "bar" | "underline" })
            }
          >
            <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-cursor-style">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURSOR_STYLES.map((style) => (
                <SelectItem key={style} value={style} className="text-xs">
                  {t(`settings.terminal.cursor.${style}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end justify-between rounded border p-3">
          <Label className="text-xs">{t("settings.terminal.cursor.blink")}</Label>
          <Switch
            checked={terminal.cursorBlink ?? true}
            onCheckedChange={(checked) => update({ cursorBlink: checked })}
            aria-label={t("settings.terminal.cursor.blink")}
            data-testid="terminal-card-cursor-blink"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">{t("settings.terminal.colorScheme.label")}</Label>
          <Select
            value={terminal.colorScheme || AUTO_SCHEME_ID}
            onValueChange={(value) => update({ colorScheme: value })}
          >
            <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-color-scheme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_SCHEME_ID} className="text-xs">
                {t("settings.terminal.colorScheme.auto")}
              </SelectItem>
              {TERMINAL_COLOR_SCHEMES.map((scheme) => (
                <SelectItem key={scheme.id} value={scheme.id} className="text-xs">
                  {scheme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">{t("settings.terminal.renderer.label")}</Label>
          <Select
            value={terminal.renderer ?? "auto"}
            onValueChange={(value) =>
              update({ renderer: value as "auto" | "webgl" | "canvas" | "dom" })
            }
          >
            <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-renderer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RENDERERS.map((r) => (
                <SelectItem key={r} value={r} className="text-xs">
                  {t(`settings.terminal.renderer.${r}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("settings.terminal.renderer.helper")}</p>

      <div className="space-y-2">
        <Label className="text-xs">{t("settings.terminal.scrollback.label")}</Label>
        <Input
          type="number"
          min={1000}
          max={100000}
          step={1000}
          value={terminal.scrollback ?? DEFAULT_VALUES.scrollback}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) {
              update({ scrollback: Math.max(1000, Math.min(100000, n)) })
            }
          }}
          className="h-8 text-xs"
          aria-label={t("settings.terminal.scrollback.label")}
          data-testid="terminal-card-scrollback"
        />
        <p className="text-[11px] text-muted-foreground">
          {t("settings.terminal.scrollback.helper")}
        </p>
      </div>

      <div className="flex items-center justify-between rounded border p-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("settings.terminal.shellIntegration.label")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.terminal.shellIntegration.helper")}
          </p>
        </div>
        <Switch
          checked={terminal.enableShellIntegration ?? true}
          onCheckedChange={(checked) => update({ enableShellIntegration: checked })}
          aria-label={t("settings.terminal.shellIntegration.label")}
        />
      </div>

      <div className="flex items-center justify-between rounded border p-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("settings.terminal.copyOnSelect.label")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.terminal.copyOnSelect.helper")}
          </p>
        </div>
        <Switch
          checked={terminal.copyOnSelect ?? false}
          onCheckedChange={(checked) => update({ copyOnSelect: checked })}
          aria-label={t("settings.terminal.copyOnSelect.label")}
          data-testid="terminal-card-copy-on-select"
        />
      </div>

      <div className="flex items-center justify-between rounded border p-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("settings.terminal.ligatures.label")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.terminal.ligatures.helper")}
          </p>
        </div>
        <Switch
          checked={terminal.fontLigatures ?? false}
          onCheckedChange={(checked) => update({ fontLigatures: checked })}
          aria-label={t("settings.terminal.ligatures.label")}
          data-testid="terminal-card-ligatures"
        />
      </div>

      <div className="flex items-center justify-between rounded border p-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("settings.terminal.forceUtf8.label")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.terminal.forceUtf8.helper")}
          </p>
        </div>
        <Switch
          checked={terminal.forceUtf8 ?? true}
          onCheckedChange={(checked) => update({ forceUtf8: checked })}
          aria-label={t("settings.terminal.forceUtf8.label")}
          data-testid="terminal-card-force-utf8"
        />
      </div>

      <div className="flex items-center justify-between rounded border p-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("settings.terminal.sandboxed.label")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.terminal.sandboxed.helper")}
          </p>
        </div>
        <Switch
          checked={terminal.sandboxed ?? false}
          onCheckedChange={(checked) => update({ sandboxed: checked })}
          aria-label={t("settings.terminal.sandboxed.label")}
          data-testid="terminal-card-sandboxed"
        />
      </div>

      <div className="flex items-center justify-between rounded border p-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("settings.terminal.exposeDockToAgents.label")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.terminal.exposeDockToAgents.helper")}
          </p>
        </div>
        <Switch
          checked={terminal.exposeDockToAgents ?? false}
          onCheckedChange={(checked) => update({ exposeDockToAgents: checked })}
          aria-label={t("settings.terminal.exposeDockToAgents.label")}
          data-testid="terminal-card-expose-to-agents"
        />
      </div>

      <div className="flex items-center justify-between rounded border p-3">
        <div className="space-y-0.5">
          <Label className="text-xs" htmlFor="terminal-card-run-in-dock-timeout">
            {t("settings.terminal.runInDockTimeout.label")}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.terminal.runInDockTimeout.helper")}
          </p>
        </div>
        <Input
          id="terminal-card-run-in-dock-timeout"
          type="number"
          min={5}
          max={600}
          className="w-24"
          value={terminal.runInDockTimeoutSec ?? 60}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (!Number.isFinite(next)) return
            update({ runInDockTimeoutSec: Math.max(5, Math.min(600, Math.floor(next))) })
          }}
          aria-label={t("settings.terminal.runInDockTimeout.label")}
          data-testid="terminal-card-run-in-dock-timeout"
        />
      </div>

      <div className="space-y-3 rounded border p-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.autocomplete.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.autocomplete.helper")}
            </p>
          </div>
          <Switch
            checked={autocomplete.enabled ?? false}
            onCheckedChange={(checked) =>
              update({ autocomplete: { ...autocomplete, enabled: checked } })
            }
            aria-label={t("settings.terminal.autocomplete.label")}
            data-testid="terminal-card-autocomplete-enabled"
          />
        </div>

        {autocomplete.enabled ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-xs">
                  {t("settings.terminal.autocomplete.source.label")}
                </Label>
                <Select
                  value={autocomplete.source ?? "both"}
                  onValueChange={(value) =>
                    update({
                      autocomplete: {
                        ...autocomplete,
                        source: value as "both" | "ai" | "history",
                      },
                    })
                  }
                >
                  <SelectTrigger
                    className="h-8 text-xs"
                    data-testid="terminal-card-autocomplete-source"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOCOMPLETE_SOURCES.map((s) => (
                      <SelectItem key={s} value={s} className="text-xs">
                        {t(`settings.terminal.autocomplete.source.${s}` as never)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs" htmlFor="terminal-card-autocomplete-debounce">
                  {t("settings.terminal.autocomplete.debounce.label")}
                </Label>
                <Input
                  id="terminal-card-autocomplete-debounce"
                  type="number"
                  min={50}
                  max={2000}
                  step={50}
                  value={autocomplete.debounceMs ?? 350}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n)) {
                      update({
                        autocomplete: {
                          ...autocomplete,
                          debounceMs: Math.max(50, Math.min(2000, Math.floor(n))),
                        },
                      })
                    }
                  }}
                  className="h-8 text-xs"
                  aria-label={t("settings.terminal.autocomplete.debounce.label")}
                  data-testid="terminal-card-autocomplete-debounce"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {(["path", "exe", "spec"] as const).map((key) => (
                <div key={key} className="flex items-center justify-between rounded border p-2">
                  <Label className="text-xs">
                    {t(`settings.terminal.autocomplete.${key}.label` as never)}
                  </Label>
                  <Switch
                    checked={autocomplete[key] ?? true}
                    onCheckedChange={(checked) =>
                      update({ autocomplete: { ...autocomplete, [key]: checked } })
                    }
                    aria-label={t(`settings.terminal.autocomplete.${key}.label` as never)}
                    data-testid={`terminal-card-autocomplete-${key}`}
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between rounded border p-3">
              <div className="space-y-0.5">
                <Label className="text-xs">{t("settings.terminal.autocomplete.popup.label")}</Label>
                <p className="text-[11px] text-muted-foreground">
                  {t("settings.terminal.autocomplete.popup.helper")}
                </p>
              </div>
              <Switch
                checked={autocomplete.popup ?? true}
                onCheckedChange={(checked) =>
                  update({ autocomplete: { ...autocomplete, popup: checked } })
                }
                aria-label={t("settings.terminal.autocomplete.popup.label")}
                data-testid="terminal-card-autocomplete-popup"
              />
            </div>

            <div className="flex items-center justify-between rounded border p-3">
              <div className="space-y-0.5">
                <Label className="text-xs">
                  {t("settings.terminal.autocomplete.persistHistory.label")}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {t("settings.terminal.autocomplete.persistHistory.helper")}
                </p>
              </div>
              <Switch
                checked={autocomplete.persistHistory ?? true}
                onCheckedChange={(checked) =>
                  update({ autocomplete: { ...autocomplete, persistHistory: checked } })
                }
                aria-label={t("settings.terminal.autocomplete.persistHistory.label")}
                data-testid="terminal-card-autocomplete-persist-history"
              />
            </div>

            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.autocomplete.privacy")}
            </p>
          </>
        ) : null}
      </div>

      <div className="space-y-3 rounded border p-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.unattended.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.unattended.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.allowUnattendedExecution ?? false}
            onCheckedChange={(checked) => update({ allowUnattendedExecution: checked })}
            aria-label={t("settings.terminal.unattended.label")}
            data-testid="terminal-card-unattended"
          />
        </div>

        {terminal.allowUnattendedExecution ? (
          <div className="space-y-2">
            <Label className="text-xs">{t("settings.terminal.unattended.askPolicy.label")}</Label>
            <Select
              value={terminal.unattendedAskPolicy ?? "fail"}
              onValueChange={(value) =>
                update({ unattendedAskPolicy: value as "fail" | "consent" | "run" })
              }
            >
              <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-unattended-policy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASK_POLICIES.map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    {t(`settings.terminal.unattended.askPolicy.${p}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.unattended.askPolicy.helper")}
            </p>
          </div>
        ) : null}
      </div>

      <TerminalProfiles />

      <TerminalProjectOverride />
    </div>
  )
}

export default TerminalCard
