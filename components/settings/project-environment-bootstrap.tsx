"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  assertBootstrapAdvancedOptions,
  BOOTSTRAP_ADVANCED_KEYS,
  BOOTSTRAP_DEFAULTS,
  BOOTSTRAP_RUNTIME_BINARIES,
  parseBootstrapAdvancedOptions,
} from "@/lib/project-environment/bootstrap-agent"
import {
  applyBootstrapProvider,
  applyBootstrapRecipe,
  applyBootstrapTaskPreset,
  BOOTSTRAP_PRESETS,
} from "@/lib/project-environment/bootstrap-presets"
import type {
  ProjectEnvironmentBootstrapAgent,
  ProjectEnvironmentScript,
} from "@/types/project-environment"

export function ProjectEnvironmentBootstrap({
  value,
  onChange,
  onApplyRecipe,
  ids,
}: {
  value?: ProjectEnvironmentBootstrapAgent
  onChange(value: ProjectEnvironmentBootstrapAgent | undefined): void
  onApplyRecipe?(value: {
    bootstrapAgent: ProjectEnvironmentBootstrapAgent
    setupScript: ProjectEnvironmentScript
  }): void
  ids: string
}) {
  const t = useTranslations("projectEnvironment.bootstrap")
  const [advancedText, setAdvancedText] = useState<string>()
  const [providerId, setProviderId] = useState(BOOTSTRAP_PRESETS.providers[0].id)
  const [taskPresetId, setTaskPresetId] = useState(BOOTSTRAP_PRESETS.presets[0].id)
  const [recipeId, setRecipeId] = useState(BOOTSTRAP_PRESETS.recipes[0].id)
  const current: ProjectEnvironmentBootstrapAgent = value ?? {
    enabled: false,
    ...BOOTSTRAP_DEFAULTS,
    task: "",
    baseUrl: "",
    model: "",
    checks: [],
  }
  const update = (patch: Partial<ProjectEnvironmentBootstrapAgent>) =>
    onChange({ ...current, ...patch })
  const updateModel = (patch: NonNullable<ProjectEnvironmentBootstrapAgent["modelOptions"]>) =>
    update({ modelOptions: { ...current.modelOptions, ...patch } })
  const updateTools = (patch: NonNullable<ProjectEnvironmentBootstrapAgent["tools"]>) =>
    update({ tools: { ...current.tools, ...patch } })
  const updateContext = (patch: NonNullable<ProjectEnvironmentBootstrapAgent["context"]>) =>
    update({ context: { ...current.context, ...patch } })
  const advancedSource =
    advancedText ??
    current.advancedOptionsDraft ??
    JSON.stringify(
      Object.fromEntries(
        BOOTSTRAP_ADVANCED_KEYS.filter((key) => current[key] !== undefined).map((key) => [
          key,
          current[key],
        ])
      ),
      null,
      2
    )
  const editAdvanced = (text: string) => {
    setAdvancedText(text)
    try {
      const parsed = parseBootstrapAdvancedOptions(text)
      const cleared = Object.fromEntries(BOOTSTRAP_ADVANCED_KEYS.map((key) => [key, undefined]))
      const next = { ...current, ...cleared, ...parsed, advancedOptionsDraft: undefined }
      assertBootstrapAdvancedOptions(next)
      onChange(next)
    } catch {
      update({ advancedOptionsDraft: text })
    }
  }
  const fields = ["task", "baseUrl", "model", "apiKeyEnv", "binary"] as const
  const limits = ["maxSteps", "totalTimeoutSecs", "commandTimeoutSecs"] as const
  return (
    <div className="space-y-2 rounded-md border p-2">
      <Label className="flex items-center gap-2 text-xs" htmlFor={`${ids}-enabled`}>
        <Switch
          id={`${ids}-enabled`}
          checked={current.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
        {t("enabled")}
      </Label>
      <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      {current.enabled && (
        <div className="space-y-2">
          <fieldset className="space-y-2 rounded-md border p-2">
            <legend className="px-1 text-xs font-medium">{t("presets.title")}</legend>
            <p className="text-[10px] text-muted-foreground">{t("presets.hint")}</p>
            {(
              [
                {
                  kind: "provider",
                  value: providerId,
                  setValue: setProviderId,
                  entries: BOOTSTRAP_PRESETS.providers,
                  apply: () => onChange(applyBootstrapProvider(current, providerId)),
                },
                {
                  kind: "task",
                  value: taskPresetId,
                  setValue: setTaskPresetId,
                  entries: BOOTSTRAP_PRESETS.presets,
                  apply: () => onChange(applyBootstrapTaskPreset(current, taskPresetId)),
                },
                {
                  kind: "recipe",
                  value: recipeId,
                  setValue: setRecipeId,
                  entries: BOOTSTRAP_PRESETS.recipes,
                  apply: () => onApplyRecipe?.(applyBootstrapRecipe(current, recipeId)),
                },
              ] as const
            ).map(({ kind, value, setValue, entries, apply }) => (
              <div key={kind} className="space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-preset-${kind}`}>
                  {t(`presets.${kind}`)}
                </Label>
                <div className="flex items-center gap-2">
                  <select
                    id={`${ids}-preset-${kind}`}
                    className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  >
                    {entries.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {t(`presets.${kind}Options.${entry.id}.label`)}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={kind === "recipe" && !onApplyRecipe}
                    onClick={() => {
                      setAdvancedText(undefined)
                      apply()
                    }}
                  >
                    {t(
                      `presets.apply${kind === "provider" ? "Provider" : kind === "task" ? "Task" : "Recipe"}`
                    )}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t(`presets.${kind}Options.${value}.description`)}
                </p>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">{t("presets.recipeHint")}</p>
          </fieldset>
          {current.model === "local-model" && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("presets.localModelHint")}
            </p>
          )}
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`${ids}-runtime`}>
              {t("runtime")}
            </Label>
            <select
              id={`${ids}-runtime`}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={current.runtime ?? "native"}
              onChange={(event) => {
                const runtime = event.target.value as NonNullable<
                  ProjectEnvironmentBootstrapAgent["runtime"]
                >
                const previousDefault = BOOTSTRAP_RUNTIME_BINARIES[current.runtime ?? "native"]
                update({
                  runtime,
                  ...(!current.binary || current.binary === previousDefault
                    ? { binary: BOOTSTRAP_RUNTIME_BINARIES[runtime] }
                    : {}),
                })
              }}
            >
              <option value="native">{t("runtimeNative")}</option>
              <option value="bash">{t("runtimeBash")}</option>
              <option value="powershell">{t("runtimePowershell")}</option>
            </select>
            <p className="text-[10px] text-muted-foreground">{t("runtimeHint")}</p>
          </div>
          {fields.map((field) => (
            <div key={field} className="space-y-1">
              <Label className="text-xs" htmlFor={`${ids}-${field}`}>
                {t(field)}
              </Label>
              {field === "task" ? (
                <Textarea
                  id={`${ids}-${field}`}
                  value={current.task}
                  onChange={(event) => update({ task: event.target.value })}
                />
              ) : (
                <Input
                  id={`${ids}-${field}`}
                  value={
                    current[field] ??
                    (field === "binary"
                      ? BOOTSTRAP_RUNTIME_BINARIES[current.runtime ?? "native"]
                      : field === "apiKeyEnv"
                        ? BOOTSTRAP_DEFAULTS.apiKeyEnv
                        : "")
                  }
                  onChange={(event) => update({ [field]: event.target.value })}
                />
              )}
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">{t("credentialHint")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${ids}-auth`}>
                {t("auth")}
              </Label>
              <select
                id={`${ids}-auth`}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={current.modelOptions?.auth ?? "bearer"}
                onChange={(event) =>
                  updateModel({ auth: event.target.value as "bearer" | "header" | "none" })
                }
              >
                <option value="bearer">{t("authBearer")}</option>
                <option value="header">{t("authHeader")}</option>
                <option value="none">{t("authNone")}</option>
              </select>
            </div>
            {current.modelOptions?.auth === "header" && (
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-apiKeyHeader`}>
                  {t("apiKeyHeader")}
                </Label>
                <Input
                  id={`${ids}-apiKeyHeader`}
                  value={current.modelOptions.apiKeyHeader ?? ""}
                  onChange={(event) => updateModel({ apiKeyHeader: event.target.value })}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${ids}-endpointPath`}>
                {t("endpointPath")}
              </Label>
              <Input
                id={`${ids}-endpointPath`}
                value={current.modelOptions?.endpointPath ?? "chat/completions"}
                onChange={(event) => updateModel({ endpointPath: event.target.value })}
              />
            </div>
            {(["requestTimeoutSecs", "maxTokens", "temperature", "topP"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-${field}`}>
                  {t(field)}
                </Label>
                <Input
                  id={`${ids}-${field}`}
                  type="number"
                  min={field === "temperature" || field === "topP" ? 0 : 1}
                  max={
                    field === "temperature"
                      ? 2
                      : field === "topP"
                        ? 1
                        : field === "requestTimeoutSecs"
                          ? 600
                          : 16777216
                  }
                  step={field === "temperature" || field === "topP" ? 0.1 : 1}
                  value={
                    current.modelOptions?.[field] ?? (field === "requestTimeoutSecs" ? 60 : "")
                  }
                  onChange={(event) =>
                    updateModel({
                      [field]: event.target.value === "" ? undefined : Number(event.target.value),
                    })
                  }
                />
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`${ids}-systemPrompt`}>
              {t("systemPrompt")}
            </Label>
            <Textarea
              id={`${ids}-systemPrompt`}
              value={current.systemPrompt ?? ""}
              onChange={(event) => update({ systemPrompt: event.target.value || undefined })}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            {(["stream", "showThinking"] as const).map((field) => (
              <Label
                key={field}
                className="flex items-center gap-2 text-xs"
                htmlFor={`${ids}-${field}`}
              >
                <Switch
                  id={`${ids}-${field}`}
                  checked={current.modelOptions?.[field] ?? false}
                  onCheckedChange={(checked) => updateModel({ [field]: checked })}
                />
                {t(field)}
              </Label>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("checks")}</p>
            {current.checks.map((check, index) => (
              <div key={index} className="flex items-start gap-1.5">
                <div className="flex-1 space-y-1">
                  <Input
                    value={check.name}
                    aria-label={t("checkName")}
                    onChange={(event) =>
                      update({
                        checks: current.checks.map((item, position) =>
                          position === index ? { ...item, name: event.target.value } : item
                        ),
                      })
                    }
                  />
                  <Textarea
                    value={check.command}
                    aria-label={t("checkCommand")}
                    onChange={(event) =>
                      update({
                        checks: current.checks.map((item, position) =>
                          position === index ? { ...item, command: event.target.value } : item
                        ),
                      })
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("removeCheck")}
                  onClick={() =>
                    update({ checks: current.checks.filter((_, position) => position !== index) })
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={current.checks.length >= 32}
              onClick={() => update({ checks: [...current.checks, { name: "", command: "" }] })}
            >
              {t("addCheck")}
            </Button>
            <p className="text-[10px] text-muted-foreground">{t("checksHint")}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {limits.map((field) => (
              <div key={field} className="space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-${field}`}>
                  {t(field)}
                </Label>
                <Input
                  id={`${ids}-${field}`}
                  type="number"
                  min={1}
                  max={field === "maxSteps" ? 256 : field === "totalTimeoutSecs" ? 3600 : 600}
                  value={current[field] ?? BOOTSTRAP_DEFAULTS[field]}
                  onChange={(event) => update({ [field]: Number(event.target.value) })}
                />
              </div>
            ))}
          </div>
          <details className="space-y-2 rounded-md border p-2">
            <summary className="cursor-pointer text-xs font-medium">{t("advanced")}</summary>
            <p className="text-[10px] text-muted-foreground">{t("advancedHint")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-profile`}>
                  {t("profile")}
                </Label>
                <select
                  id={`${ids}-profile`}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={current.tools?.profile ?? "native"}
                  onChange={(event) =>
                    updateTools({ profile: event.target.value as "native" | "dsh" })
                  }
                >
                  <option value="native">{t("profileNative")}</option>
                  <option value="dsh">{t("profileDsh")}</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-shellExecutable`}>
                  {t("shellExecutable")}
                </Label>
                <Input
                  id={`${ids}-shellExecutable`}
                  value={
                    current.tools?.shellExecutable ??
                    (current.runtime === "powershell" ? "pwsh" : "/bin/bash")
                  }
                  onChange={(event) => updateTools({ shellExecutable: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-contextWindowTokens`}>
                  {t("contextWindowTokens")}
                </Label>
                <Input
                  id={`${ids}-contextWindowTokens`}
                  type="number"
                  min={128}
                  max={16777216}
                  value={current.context?.contextWindowTokens ?? 1000000}
                  onChange={(event) =>
                    updateContext({ contextWindowTokens: Number(event.target.value) })
                  }
                />
              </div>
              {(["maxOutputBytes", "maxContextBytes", "maxResponseBytes"] as const).map((field) => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs" htmlFor={`${ids}-${field}`}>
                    {t(field)}
                  </Label>
                  <Input
                    id={`${ids}-${field}`}
                    type="number"
                    min={
                      field === "maxOutputBytes" ? 256 : field === "maxContextBytes" ? 4096 : 1024
                    }
                    max={field === "maxOutputBytes" ? 1048576 : 8388608}
                    value={
                      current[field] ??
                      (field === "maxOutputBytes"
                        ? 16000
                        : field === "maxContextBytes"
                          ? 128000
                          : 1048576)
                    }
                    onChange={(event) => update({ [field]: Number(event.target.value) })}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              {(["shell", "editor"] as const).map((field) => (
                <Label
                  key={field}
                  className="flex items-center gap-2 text-xs"
                  htmlFor={`${ids}-tool-${field}`}
                >
                  <Switch
                    id={`${ids}-tool-${field}`}
                    checked={current.tools?.[field] ?? true}
                    onCheckedChange={(checked) => updateTools({ [field]: checked })}
                  />
                  {t(`tool${field === "shell" ? "Shell" : "Editor"}`)}
                </Label>
              ))}
              {(["autoCompact", "pruneToolResults"] as const).map((field) => (
                <Label
                  key={field}
                  className="flex items-center gap-2 text-xs"
                  htmlFor={`${ids}-${field}`}
                >
                  <Switch
                    id={`${ids}-${field}`}
                    checked={current.context?.[field] ?? true}
                    onCheckedChange={(checked) => updateContext({ [field]: checked })}
                  />
                  {t(field)}
                </Label>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["inputs", "outputs"] as const).map((field) => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs" htmlFor={`${ids}-reuse-${field}`}>
                    {t(`reuse${field === "inputs" ? "Inputs" : "Outputs"}`)}
                  </Label>
                  <Textarea
                    id={`${ids}-reuse-${field}`}
                    value={(current.reuse?.[field] ?? []).join("\n")}
                    onChange={(event) =>
                      update({
                        reuse: {
                          ...current.reuse,
                          [field]: event.target.value
                            .split("\n")
                            .map((line) => line.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <Label className="text-xs" htmlFor={`${ids}-advanced`}>
              {t("advancedJson")}
            </Label>
            <Textarea
              id={`${ids}-advanced`}
              rows={12}
              className="font-mono text-xs"
              value={advancedSource}
              aria-invalid={current.advancedOptionsDraft !== undefined}
              aria-describedby={`${ids}-advanced-help`}
              onChange={(event) => editAdvanced(event.target.value)}
              onBlur={() => setAdvancedText(undefined)}
            />
            <p id={`${ids}-advanced-help`} className="text-[10px] text-muted-foreground">
              {t("advancedSchema")}
            </p>
            {current.advancedOptionsDraft !== undefined && (
              <p role="alert" className="text-xs text-destructive">
                {t("validation.options")}
              </p>
            )}
          </details>
        </div>
      )}
    </div>
  )
}
