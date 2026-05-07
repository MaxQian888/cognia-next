"use client"

import { useEffect, useState } from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { FolderOpenIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { isTauri } from "@/lib/tauri"
import type { AppSettings } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"
import { createLogger } from "@/lib/logger"
import { MODEL_PRESET_VALUES, PERMISSION_MODE_VALUES } from "@/lib/claude/model-presets"

const log = createLogger("settings.general")

export function GeneralSection({ onClose }: { onClose: () => void }) {
  const t = useTranslations("settings.general")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const toggle = useSettingsStore((s) => s.toggleAlwaysAllow)

  const [model, setModel] = useState<string>("")
  const [systemPrompt, setSystemPrompt] = useState<string>("")
  const [workingDir, setWorkingDir] = useState<string>("")
  const [permissionMode, setPermissionMode] =
    useState<NonNullable<AppSettings["permissionMode"]>>("default")
  const [bareMode, setBareMode] = useState<boolean>(false)
  const [debugMode, setDebugMode] = useState<boolean>(false)
  const [briefMode, setBriefMode] = useState<boolean>(false)

  useEffect(() => {
    if (!settings) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setModel(settings.defaultModel ?? "")
    setSystemPrompt(settings.defaultSystemPrompt ?? "")
    setWorkingDir(settings.defaultWorkingDir ?? "")
    setPermissionMode(settings.permissionMode ?? "default")
    setBareMode(Boolean(settings.bareMode))
    setDebugMode(Boolean(settings.debugMode))
    setBriefMode(Boolean(settings.briefMode))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings])

  const handlePickDir = async () => {
    if (!isTauri()) return
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("selectWorkingDirectory"),
      })
      if (typeof picked === "string") setWorkingDir(picked)
    } catch (err) {
      log.error("general.pickDirFailed", err)
    }
  }

  const handleSave = async () => {
    try {
      await save({
        defaultModel: model.trim() || undefined,
        defaultSystemPrompt: systemPrompt.trim() || undefined,
        defaultWorkingDir: workingDir.trim() || undefined,
        permissionMode,
        bareMode: bareMode || undefined,
        debugMode: debugMode || undefined,
        briefMode: briefMode || undefined,
      })
      log.info("general.defaultsSaved", {
        modelSet: Boolean(model.trim()),
        systemPromptSet: Boolean(systemPrompt.trim()),
        workingDirSet: Boolean(workingDir.trim()),
        permissionMode,
        bareMode,
        debugMode,
        briefMode,
      })
      toast.success(t("saved"))
    } catch (err) {
      log.error("general.saveFailed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="settings-model">{t("defaultModel")}</Label>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger id="settings-model">
            <SelectValue placeholder={t("useSdkDefault")} />
          </SelectTrigger>
          <SelectContent>
            {MODEL_PRESET_VALUES.map((v) => (
              <SelectItem key={v} value={v}>
                {t(`model.${v}` as `model.${typeof v}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id="settings-model-custom"
          placeholder={t("orPasteModelId")}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-workdir">{t("workingDirectory")}</Label>
        <div className="flex gap-2">
          <Input
            id="settings-workdir"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder={t("dirPlaceholder")}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handlePickDir}
            disabled={!isTauri()}
            aria-label={t("pickDirectory")}
          >
            <FolderOpenIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-permission">{t("permissionMode")}</Label>
        <Select
          value={permissionMode}
          onValueChange={(v) => setPermissionMode(v as NonNullable<AppSettings["permissionMode"]>)}
        >
          <SelectTrigger id="settings-permission">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_MODE_VALUES.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`permission.${m}` as `permission.${typeof m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("permissionModeHintBefore")}
          <code className="rounded bg-muted px-1 py-0.5">{t("permissionModeHintCode")}</code>
          {t("permissionModeHintAfter")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-system">{t("defaultSystemPrompt")}</Label>
        <Textarea
          id="settings-system"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t("defaultSystemPromptPlaceholder")}
          rows={4}
        />
      </div>

      <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="settings-bare-mode" className="text-sm">
              {t("bareMode")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("bareModeHint")}</p>
          </div>
          <Switch
            id="settings-bare-mode"
            checked={bareMode}
            onCheckedChange={setBareMode}
            aria-label={t("bareMode")}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="settings-debug-mode" className="text-sm">
              {t("debugMode")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("debugModeHint")}</p>
          </div>
          <Switch
            id="settings-debug-mode"
            checked={debugMode}
            onCheckedChange={setDebugMode}
            aria-label={t("debugMode")}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="settings-brief-mode" className="text-sm">
              {t("briefMode")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("briefModeHint")}</p>
          </div>
          <Switch
            id="settings-brief-mode"
            checked={briefMode}
            onCheckedChange={setBriefMode}
            aria-label={t("briefMode")}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("alwaysAllowedTools")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {(settings?.alwaysAllowTools ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">{t("noneYet")}</p>
          )}
          {settings?.alwaysAllowTools?.map((tool) => (
            <Badge key={tool} variant="secondary" className="gap-1 pr-1.5 font-mono">
              {tool}
              <button
                type="button"
                onClick={() => {
                  log.info("general.alwaysAllowRemoved", { tool })
                  void toggle(tool, false)
                }}
                aria-label={t("removeFromAllowList", { tool })}
                className="rounded-sm hover:bg-muted"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button onClick={handleSave}>{t("save")}</Button>
      </div>
    </div>
  )
}
