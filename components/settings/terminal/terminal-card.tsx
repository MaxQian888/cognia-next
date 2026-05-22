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

import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"

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
}

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

      <TerminalProjectOverride />
    </div>
  )
}

export default TerminalCard
