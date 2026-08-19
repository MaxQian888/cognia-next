"use client"

/**
 * Logs → Levels.
 *
 * The global threshold, the two per-entry enrichment toggles, and the
 * per-module overrides that beat both — plus the native (Rust) target levels,
 * which are the same idea one layer down and used to sit in a different tab.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ListFilterIcon, PlusIcon, RadioIcon, Trash2Icon } from "lucide-react"

import { NativeLogLevels } from "@/components/logging/native-log-levels"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getRegisteredModules, type LogLevel } from "@/lib/logging"

import { LOG_LEVELS } from "../log-levels"
import type { UseLogSettingsDraftResult } from "@/hooks/logging/use-log-settings-draft"

export interface LogsLevelsPanelProps {
  draft: UseLogSettingsDraftResult
}

export function LogsLevelsPanel({ draft }: LogsLevelsPanelProps) {
  const t = useTranslations("logging")
  const [newOverride, setNewOverride] = useState<{ prefix: string; level: LogLevel }>({
    prefix: "",
    level: "debug",
  })

  const registeredModules = useMemo(() => getRegisteredModules(), [])
  const overrides = useMemo(
    () =>
      Object.entries(draft.config.perModuleLevels ?? {}).sort(([left], [right]) =>
        left.localeCompare(right)
      ) as Array<[string, LogLevel]>,
    [draft.config.perModuleLevels]
  )

  const addOverride = () => {
    if (!newOverride.prefix.trim()) return
    draft.setModuleLevel(newOverride.prefix, newOverride.level)
    setNewOverride({ prefix: "", level: "debug" })
  }

  return (
    <SettingsStack>
      <SettingsBlock
        icon={<ListFilterIcon />}
        title={t("settings.logLevel.title")}
        description={t("settings.logLevel.description")}
        testid="logs-levels-threshold"
      >
        <SettingsField
          htmlFor="logs-min-level"
          label={t("settings.logLevel.minLevel")}
          description={t("settings.logLevel.minLevelHint")}
        >
          <Select
            value={draft.config.minLevel}
            onValueChange={(value) => draft.setConfig("minLevel", value as LogLevel)}
          >
            <SelectTrigger id="logs-min-level" className="w-[160px]">
              {/* Explicit children: the options are two-line (name + what it
                  means) and Radix mirrors the whole item into the trigger,
                  which overflowed a control this size. */}
              <SelectValue>{t(`settings.logLevel.${draft.config.minLevel}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LOG_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    <div className="flex flex-col">
                      <span className="capitalize">{t(`settings.logLevel.${level}`)}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(`settings.logLevel.${level}Desc`)}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsField>

        <SettingsField
          htmlFor="logs-include-stack"
          label={t("settings.options.includeStackTrace")}
          description={t("settings.options.includeStackTraceDesc")}
        >
          <Switch
            id="logs-include-stack"
            checked={draft.config.includeStackTrace}
            onCheckedChange={(checked) => draft.setConfig("includeStackTrace", checked)}
          />
        </SettingsField>

        <SettingsField
          htmlFor="logs-include-source"
          label={t("settings.options.includeSource")}
          description={t("settings.options.includeSourceDesc")}
        >
          <Switch
            id="logs-include-source"
            checked={draft.config.includeSource}
            onCheckedChange={(checked) => draft.setConfig("includeSource", checked)}
          />
        </SettingsField>
      </SettingsBlock>

      <SettingsBlock
        icon={<RadioIcon />}
        title={t("settings.moduleLevels.title")}
        description={t("settings.moduleLevels.description")}
        testid="logs-levels-modules"
      >
        <datalist id="logging-registered-modules">
          {registeredModules.map((moduleName) => (
            <option key={moduleName} value={moduleName} />
          ))}
        </datalist>

        {overrides.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.moduleLevels.empty")}</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border">
            {overrides.map(([prefix, level]) => (
              <li key={prefix} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{prefix}</span>
                <Select
                  value={level}
                  onValueChange={(value) => draft.setModuleLevel(prefix, value as LogLevel)}
                >
                  <SelectTrigger className="h-8 w-[130px]" aria-label={prefix}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {LOG_LEVELS.map((option) => (
                        <SelectItem key={option} value={option}>
                          <span className="capitalize">{t(`settings.logLevel.${option}`)}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={t("settings.moduleLevels.removeAria", { module: prefix })}
                  onClick={() => draft.removeModuleLevel(prefix)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 @md/settings-stack:flex-row @md/settings-stack:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="logs-new-module" className="text-xs">
              {t("settings.moduleLevels.moduleLabel")}
            </Label>
            <Input
              id="logs-new-module"
              list="logging-registered-modules"
              placeholder={t("settings.moduleLevels.modulePlaceholder")}
              value={newOverride.prefix}
              onChange={(event) =>
                setNewOverride((previous) => ({ ...previous, prefix: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="logs-new-module-level" className="text-xs">
              {t("settings.moduleLevels.levelLabel")}
            </Label>
            <Select
              value={newOverride.level}
              onValueChange={(value) =>
                setNewOverride((previous) => ({ ...previous, level: value as LogLevel }))
              }
            >
              <SelectTrigger
                id="logs-new-module-level"
                className="w-full @md/settings-stack:w-[130px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LOG_LEVELS.map((option) => (
                    <SelectItem key={option} value={option}>
                      <span className="capitalize">{t(`settings.logLevel.${option}`)}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={addOverride} disabled={!newOverride.prefix.trim()}>
            <PlusIcon className="mr-1 size-4" />
            {t("settings.moduleLevels.add")}
          </Button>
        </div>
      </SettingsBlock>

      {/* Tauri-only; renders null in the browser and Capacitor shells. */}
      <NativeLogLevels />
    </SettingsStack>
  )
}
