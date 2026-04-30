"use client"

/**
 * Script task editor.
 *
 * Cognia's version embeds a Monaco editor with workbench bindings; cognia-next
 * doesn't ship a Monaco integration, so we substitute a plain `<Textarea>`.
 * The rest of the editor (language picker, validation feedback, advanced
 * settings collapsible) mirrors Cognia 1:1 so the form parent stays unchanged.
 */

import { AlertTriangle, Play, Settings2 } from "lucide-react"
import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

import { validateScript, getScriptTemplate } from "@/lib/scheduler/script-executor"
import type { ExecuteScriptAction } from "@/types/scheduler"
import { SCRIPT_LANGUAGES, DEFAULT_SCRIPT_SETTINGS } from "@/types/scheduler"

export interface ScriptTaskEditorProps {
  value: ExecuteScriptAction
  onChange: (value: ExecuteScriptAction) => void
  onTest?: () => void
  disabled?: boolean
}

export function ScriptTaskEditor({
  value,
  onChange,
  onTest,
  disabled = false,
}: ScriptTaskEditorProps) {
  const t = useTranslations("scheduler")
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [validation, setValidation] = useState<{
    valid: boolean
    errors: string[]
    warnings: string[]
  } | null>(null)

  const handleLanguageChange = useCallback(
    (language: string) => {
      const code = value.code.trim() === "" ? getScriptTemplate(language) : value.code
      onChange({ ...value, language, code })
    },
    [value, onChange]
  )

  const handleCodeChange = useCallback(
    (code: string) => {
      onChange({ ...value, code })
      setValidation(validateScript(value.language, code))
    },
    [value, onChange]
  )

  const handleSettingChange = useCallback(
    <K extends keyof ExecuteScriptAction>(key: K, val: ExecuteScriptAction[K]) => {
      onChange({ ...value, [key]: val })
    },
    [value, onChange]
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t("scriptLanguage") || "Script Language"}</Label>
        <Select value={value.language} onValueChange={handleLanguageChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue placeholder={t("selectLanguage") || "Select language"} />
          </SelectTrigger>
          <SelectContent>
            {SCRIPT_LANGUAGES.map((lang) => (
              <SelectItem key={lang.value} value={lang.value}>
                <span className="flex items-center gap-2">
                  <span>{lang.icon}</span>
                  <span>{lang.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("scriptCode") || "Script Code"}</Label>
          {onTest && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTest}
              disabled={disabled || !value.code.trim()}
            >
              <Play className="mr-1 h-3 w-3" />
              {t("test") || "Test"}
            </Button>
          )}
        </div>
        <Textarea
          value={value.code}
          onChange={(e) => handleCodeChange(e.target.value)}
          disabled={disabled}
          placeholder={getScriptTemplate(value.language || "python")}
          className="font-mono text-xs"
          rows={12}
          spellCheck={false}
        />

        {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
          <div className="space-y-2">
            {validation.errors.map((error, i) => (
              <Alert key={`error-${i}`} variant="destructive" className="py-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">{error}</AlertDescription>
              </Alert>
            ))}
            {validation.warnings.map((warning, i) => (
              <Alert
                key={`warning-${i}`}
                className="border-yellow-500/50 bg-yellow-500/10 py-2 [&>svg]:text-yellow-500"
              >
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs text-yellow-600 dark:text-yellow-400">
                  {warning}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="p-3 pb-0">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <CardTitle className="text-sm font-medium">
                {t("sandboxExecution") || "Sandbox Execution"}
              </CardTitle>
              <CardDescription className="text-xs">
                {t("sandboxDescription") || "Run script in isolated environment (safer)"}
              </CardDescription>
            </div>
            <Switch
              checked={value.use_sandbox !== false}
              onCheckedChange={(checked) => handleSettingChange("use_sandbox", checked)}
              disabled={disabled}
            />
          </div>
        </CardHeader>
      </Card>

      <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-full justify-start">
            <Settings2 className="mr-2 h-4 w-4" />
            {t("advancedSettings") || "Advanced Settings"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("timeoutSeconds") || "Timeout (seconds)"}</Label>
              <Input
                type="number"
                value={value.timeout_secs ?? DEFAULT_SCRIPT_SETTINGS.timeout_secs}
                onChange={(e) =>
                  handleSettingChange("timeout_secs", parseInt(e.target.value) || 300)
                }
                min={1}
                max={3600}
                disabled={disabled}
              />
            </div>

            <div className="space-y-2">
              <Label>{t("memoryLimitMB") || "Memory Limit (MB)"}</Label>
              <Input
                type="number"
                value={value.memory_mb ?? DEFAULT_SCRIPT_SETTINGS.memory_mb}
                onChange={(e) => handleSettingChange("memory_mb", parseInt(e.target.value) || 512)}
                min={64}
                max={8192}
                disabled={disabled}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("workingDirectory") || "Working Directory"}</Label>
            <Input
              value={value.working_dir || ""}
              onChange={(e) => handleSettingChange("working_dir", e.target.value || undefined)}
              placeholder={t("workingDirPlaceholder") || "(Optional) Script execution directory"}
              disabled={disabled}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("commandLineArgs") || "Command Line Arguments"}</Label>
            <Input
              value={(value.args || []).join(" ")}
              onChange={(e) =>
                handleSettingChange(
                  "args",
                  e.target.value ? e.target.value.split(" ").filter(Boolean) : []
                )
              }
              placeholder="arg1 arg2 arg3"
              disabled={disabled}
            />
            <p className="text-muted-foreground text-xs">
              {t("argsDescription") || "Space-separated list of arguments"}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
