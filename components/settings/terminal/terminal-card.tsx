"use client"

/**
 * Settings card for the integrated terminal dock.
 *
 * Modeled on `components/settings/appearance/components/density-card.tsx`:
 *   * reads / writes via `useSettingsStore()`,
 *   * one-line label + control pattern,
 *   * `save({ terminal: {...} })` debounces persistence in the store.
 *
 * Controls are grouped into labeled sections (Appearance · Shell & session ·
 * Behavior · Productivity · AI autocomplete · Agents & automation) so the long
 * settings list stays scannable — mirrors how VS Code buckets terminal
 * settings. Every control keeps a stable `data-testid`, so grouping is purely
 * presentational.
 */

import type { ReactNode } from "react"

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  AUTO_SCHEME_ID,
  TERMINAL_COLOR_SCHEMES,
  type TerminalColorScheme,
} from "@/lib/terminal/color-schemes"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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

/** Concrete (non-optional) font-weight union offered by the pickers. */
type FontWeightOption =
  "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900"

const DEFAULT_VALUES: TerminalSettings = {
  defaultShell: "",
  fontFamily: "",
  fontSize: 13,
  fontWeight: "normal",
  fontWeightBold: "bold",
  lineHeight: 1,
  letterSpacing: 0,
  scrollback: 10000,
  enableShellIntegration: true,
  copyOnSelect: false,
  exposeDockToAgents: false,
  runInDockTimeoutSec: 60,
  cursorStyle: "block",
  cursorWidth: 1,
  cursorInactiveStyle: "outline",
  cursorBlink: true,
  fontLigatures: false,
  customGlyphs: true,
  rescaleOverlappingGlyphs: true,
  drawBoldTextInBrightColors: true,
  forceUtf8: true,
  colorScheme: AUTO_SCHEME_ID,
  renderer: "auto",
  scrollSensitivity: 1,
  smoothScrolling: false,
  minimumContrastRatio: 1,
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
  quickFixes: true,
  commandActions: true,
  stickyScroll: true,
  confirmOnClose: true,
  bell: "none",
}

/** Font-weight options offered by the pickers — CSS keywords + the numeric scale. */
const FONT_WEIGHTS: readonly FontWeightOption[] = [
  "normal",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "bold",
]

/** Minimum-contrast presets. `1` disables enforcement; 4.5/7 are WCAG AA/AAA; 21 forces black/white. */
const CONTRAST_PRESETS: ReadonlyArray<{ value: number; labelKey: string }> = [
  { value: 1, labelKey: "settings.terminal.minContrast.off" },
  { value: 4.5, labelKey: "settings.terminal.minContrast.aa" },
  { value: 7, labelKey: "settings.terminal.minContrast.aaa" },
  { value: 21, labelKey: "settings.terminal.minContrast.max" },
]

const ASK_POLICIES: ReadonlyArray<"fail" | "consent" | "run"> = ["fail", "consent", "run"]

const BELL_STYLES: ReadonlyArray<"none" | "visual" | "sound" | "both"> = [
  "none",
  "visual",
  "sound",
  "both",
]

/** Named schemes split by their palette appearance, for the grouped picker. */
const DARK_SCHEMES = TERMINAL_COLOR_SCHEMES.filter((s) => s.appearance === "dark")
const LIGHT_SCHEMES = TERMINAL_COLOR_SCHEMES.filter((s) => s.appearance === "light")

/**
 * Inline palette preview for a color-scheme option: the scheme's background
 * as a chip with four representative ANSI dots (red / green / yellow / blue),
 * so the user can compare palettes without applying them.
 */
function SchemeSwatch({ scheme }: { scheme: TerminalColorScheme }) {
  const { theme } = scheme
  return (
    <span
      aria-hidden
      className="inline-flex h-4 items-center gap-0.5 rounded-sm border px-1"
      style={{ backgroundColor: theme.background }}
      data-testid={`terminal-scheme-swatch-${scheme.id}`}
    >
      {[theme.red, theme.green, theme.yellow, theme.blue].map((color, i) => (
        <span key={i} className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      ))}
    </span>
  )
}

const AUTOCOMPLETE_SOURCES: ReadonlyArray<"both" | "ai" | "history"> = ["both", "ai", "history"]

const RENDERERS: ReadonlyArray<"auto" | "webgl" | "canvas" | "dom"> = [
  "auto",
  "webgl",
  "canvas",
  "dom",
]

/**
 * Recommended font stack for oh-my-posh / powerline prompts. Leads with the
 * app-bundled "MesloLGS NF" (see the `@font-face` in globals.css) so the icon
 * glyphs render without the user installing anything; the rest are fallbacks —
 * CaskaydiaCove for machines that happen to have it, then plain coding fonts.
 */
const NERD_FONT_STACK =
  '"MesloLGS NF", "CaskaydiaCove Nerd Font", "JetBrains Mono", "Cascadia Code", monospace'

const CURSOR_STYLES: ReadonlyArray<"block" | "bar" | "underline"> = ["block", "bar", "underline"]
const INACTIVE_CURSOR_STYLES: ReadonlyArray<{
  value: "outline" | "block" | "bar" | "underline" | "none"
  labelKey: string
}> = [
  { value: "outline", labelKey: "settings.terminal.cursor.inactiveOutline" },
  { value: "block", labelKey: "settings.terminal.cursor.inactiveBlock" },
  { value: "bar", labelKey: "settings.terminal.cursor.inactiveBar" },
  { value: "underline", labelKey: "settings.terminal.cursor.inactiveUnderline" },
  { value: "none", labelKey: "settings.terminal.cursor.inactiveNone" },
]

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

/** Labeled section header — groups the long settings list for scannability. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="border-b pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

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

  /** Render a font-weight option: CSS keywords via i18n, numeric weights verbatim. */
  function weightLabel(w: FontWeightOption): string {
    if (w === "normal") return t("settings.terminal.fontWeight.normal")
    if (w === "bold") return t("settings.terminal.fontWeight.bold")
    return w
  }

  const currentShellValue = !terminal.defaultShell
    ? AUTO
    : SHELL_PRESETS.find(
          (p) => p.value === terminal.defaultShell && p.value !== AUTO && p.value !== CUSTOM
        )
      ? terminal.defaultShell
      : CUSTOM

  return (
    <div className="space-y-6">
      <Section title={t("settings.terminal.groups.appearance")}>
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
              placeholder={
                /* i18n-exempt: example font stack, not translatable UI */ '"JetBrains Mono", monospace'
              }
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
            <Label className="text-xs">{t("settings.terminal.fontWeight.label")}</Label>
            <Select
              value={terminal.fontWeight ?? "normal"}
              onValueChange={(value) => update({ fontWeight: value as FontWeightOption })}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-font-weight">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_WEIGHTS.map((w) => (
                  <SelectItem key={w} value={w} className="text-xs">
                    {weightLabel(w)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t("settings.terminal.fontWeightBold.label")}</Label>
            <Select
              value={terminal.fontWeightBold ?? "bold"}
              onValueChange={(value) => update({ fontWeightBold: value as FontWeightOption })}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-font-weight-bold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_WEIGHTS.map((w) => (
                  <SelectItem key={w} value={w} className="text-xs">
                    {weightLabel(w)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs">{t("settings.terminal.lineHeight.label")}</Label>
            <Input
              type="number"
              min={0.8}
              max={2}
              step={0.05}
              value={terminal.lineHeight ?? 1}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) update({ lineHeight: Math.max(0.8, Math.min(2, n)) })
              }}
              className="h-8 text-xs"
              aria-label={t("settings.terminal.lineHeight.label")}
              data-testid="terminal-card-line-height"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t("settings.terminal.letterSpacing.label")}</Label>
            <Input
              type="number"
              min={-2}
              max={8}
              step={0.5}
              value={terminal.letterSpacing ?? 0}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) update({ letterSpacing: Math.max(-2, Math.min(8, n)) })
              }}
              className="h-8 text-xs"
              aria-label={t("settings.terminal.letterSpacing.label")}
              data-testid="terminal-card-letter-spacing"
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("settings.terminal.lineHeight.helper")}
        </p>

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
            <Label className="text-xs">{t("settings.terminal.cursor.width")}</Label>
            <Input
              type="number"
              min={1}
              max={10}
              step={1}
              value={terminal.cursorWidth ?? 1}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) {
                  update({ cursorWidth: Math.max(1, Math.min(10, Math.round(n))) })
                }
              }}
              className="h-8 text-xs"
              aria-label={t("settings.terminal.cursor.width")}
              data-testid="terminal-card-cursor-width"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t("settings.terminal.cursor.inactiveLabel")}</Label>
            <Select
              value={terminal.cursorInactiveStyle ?? "outline"}
              onValueChange={(value) =>
                update({
                  cursorInactiveStyle: value as "outline" | "block" | "bar" | "underline" | "none",
                })
              }
            >
              <SelectTrigger
                className="h-8 text-xs"
                data-testid="terminal-card-cursor-inactive-style"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INACTIVE_CURSOR_STYLES.map((style) => (
                  <SelectItem key={style.value} value={style.value} className="text-xs">
                    {t(style.labelKey as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("settings.terminal.cursor.widthHelper")}
        </p>

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
                <SelectGroup>
                  <SelectLabel className="text-[11px]">
                    {t("settings.terminal.colorScheme.darkGroup")}
                  </SelectLabel>
                  {DARK_SCHEMES.map((scheme) => (
                    <SelectItem key={scheme.id} value={scheme.id} className="text-xs">
                      <SchemeSwatch scheme={scheme} />
                      {scheme.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel className="text-[11px]">
                    {t("settings.terminal.colorScheme.lightGroup")}
                  </SelectLabel>
                  {LIGHT_SCHEMES.map((scheme) => (
                    <SelectItem key={scheme.id} value={scheme.id} className="text-xs">
                      <SchemeSwatch scheme={scheme} />
                      {scheme.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
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
        <p className="text-[11px] text-muted-foreground">
          {t("settings.terminal.renderer.helper")}
        </p>

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
            <Label className="text-xs">{t("settings.terminal.customGlyphs.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.customGlyphs.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.customGlyphs ?? true}
            onCheckedChange={(checked) => update({ customGlyphs: checked })}
            aria-label={t("settings.terminal.customGlyphs.label")}
            data-testid="terminal-card-custom-glyphs"
          />
        </div>

        <div className="flex items-center justify-between rounded border p-3">
          <div className="space-y-0.5">
            <Label className="text-xs">
              {t("settings.terminal.rescaleOverlappingGlyphs.label")}
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.rescaleOverlappingGlyphs.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.rescaleOverlappingGlyphs ?? true}
            onCheckedChange={(checked) => update({ rescaleOverlappingGlyphs: checked })}
            aria-label={t("settings.terminal.rescaleOverlappingGlyphs.label")}
            data-testid="terminal-card-rescale-overlapping-glyphs"
          />
        </div>

        <div className="flex items-center justify-between rounded border p-3">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.boldBrightColors.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.boldBrightColors.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.drawBoldTextInBrightColors ?? true}
            onCheckedChange={(checked) => update({ drawBoldTextInBrightColors: checked })}
            aria-label={t("settings.terminal.boldBrightColors.label")}
            data-testid="terminal-card-bold-bright-colors"
          />
        </div>
      </Section>

      <Section title={t("settings.terminal.groups.shell")}>
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
              placeholder={
                /* i18n-exempt: example shell path, not translatable UI */ "/usr/local/bin/fish"
              }
              onChange={(e) => update({ defaultShell: e.target.value })}
              className="h-8 text-xs"
              aria-label={t("settings.terminal.shell.customLabel")}
            />
          ) : null}
          <p className="text-[11px] text-muted-foreground">{t("settings.terminal.shell.helper")}</p>
        </div>

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
      </Section>

      <Section title={t("settings.terminal.groups.behavior")}>
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

        <div className="space-y-2">
          <Label className="text-xs">{t("settings.terminal.bell.label")}</Label>
          <Select
            value={terminal.bell ?? "none"}
            onValueChange={(value) =>
              update({ bell: value as "none" | "visual" | "sound" | "both" })
            }
          >
            <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-bell">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BELL_STYLES.map((b) => (
                <SelectItem key={b} value={b} className="text-xs">
                  {t(`settings.terminal.bell.${b}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{t("settings.terminal.bell.helper")}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs">{t("settings.terminal.scrollSensitivity.label")}</Label>
            <Input
              type="number"
              min={1}
              max={10}
              step={1}
              value={terminal.scrollSensitivity ?? 1}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) {
                  update({ scrollSensitivity: Math.max(1, Math.min(10, Math.round(n))) })
                }
              }}
              className="h-8 text-xs"
              aria-label={t("settings.terminal.scrollSensitivity.label")}
              data-testid="terminal-card-scroll-sensitivity"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t("settings.terminal.minContrast.label")}</Label>
            <Select
              value={String(terminal.minimumContrastRatio ?? 1)}
              onValueChange={(value) => update({ minimumContrastRatio: Number(value) })}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="terminal-card-min-contrast">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTRAST_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={String(p.value)} className="text-xs">
                    {t(p.labelKey as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("settings.terminal.minContrast.helper")}
        </p>

        <div className="flex items-center justify-between rounded border p-3">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.smoothScrolling.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.smoothScrolling.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.smoothScrolling ?? false}
            onCheckedChange={(checked) => update({ smoothScrolling: checked })}
            aria-label={t("settings.terminal.smoothScrolling.label")}
            data-testid="terminal-card-smooth-scrolling"
          />
        </div>

        <div className="flex items-center justify-between rounded border p-3">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.confirmOnClose.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.confirmOnClose.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.confirmOnClose ?? true}
            onCheckedChange={(checked) => update({ confirmOnClose: checked })}
            aria-label={t("settings.terminal.confirmOnClose.label")}
            data-testid="terminal-card-confirm-on-close"
          />
        </div>
      </Section>

      <Section title={t("settings.terminal.groups.productivity")}>
        <div className="flex items-center justify-between rounded border p-3">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.quickFixes.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.quickFixes.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.quickFixes ?? true}
            onCheckedChange={(checked) => update({ quickFixes: checked })}
            aria-label={t("settings.terminal.quickFixes.label")}
            data-testid="terminal-card-quick-fixes"
          />
        </div>

        <div className="flex items-center justify-between rounded border p-3">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.commandActions.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.commandActions.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.commandActions ?? true}
            onCheckedChange={(checked) => update({ commandActions: checked })}
            aria-label={t("settings.terminal.commandActions.label")}
            data-testid="terminal-card-command-actions"
          />
        </div>

        <div className="flex items-center justify-between rounded border p-3">
          <div className="space-y-0.5">
            <Label className="text-xs">{t("settings.terminal.stickyScroll.label")}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.terminal.stickyScroll.helper")}
            </p>
          </div>
          <Switch
            checked={terminal.stickyScroll ?? true}
            onCheckedChange={(checked) => update({ stickyScroll: checked })}
            aria-label={t("settings.terminal.stickyScroll.label")}
            data-testid="terminal-card-sticky-scroll"
          />
        </div>
      </Section>

      <Section title={t("settings.terminal.groups.ai")}>
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
                  <Label className="text-xs">
                    {t("settings.terminal.autocomplete.popup.label")}
                  </Label>
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
      </Section>

      <Section title={t("settings.terminal.groups.agents")}>
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
                <SelectTrigger
                  className="h-8 text-xs"
                  data-testid="terminal-card-unattended-policy"
                >
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
      </Section>

      <TerminalProfiles />

      <TerminalProjectOverride />
    </div>
  )
}

export default TerminalCard
