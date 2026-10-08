"use client"

/**
 * The bootstrap Agent: an optional model-driven initialization that runs
 * before the full Agent runtime, as one chapter of the environment editor.
 *
 * Its frame used to be a bordered box with a bordered fieldset and a bordered
 * `<details>` inside, three frames deep in a form already inside two. The
 * section heading now names it, the presets are an aside under a rule, and the
 * remaining fields are grouped by concern (task, model connection,
 * generation, readiness checks, limits) under small headings. Every grid sizes
 * off the editor's container, not the viewport: the session sheet is 448px on
 * any monitor, and `sm:grid-cols-2` there put two fields side by side in it.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
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
  const connectionFields = ["baseUrl", "model", "apiKeyEnv"] as const
  const limits = ["maxSteps", "totalTimeoutSecs", "commandTimeoutSecs"] as const
  const textField = (field: "task" | "baseUrl" | "model" | "apiKeyEnv" | "binary") => (
    <div key={field} className="min-w-0 space-y-1">
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
          className={field === "binary" || field === "apiKeyEnv" ? "font-mono text-xs" : undefined}
          onChange={(event) => update({ [field]: event.target.value })}
        />
      )}
    </div>
  )
  return (
    <div className="space-y-4" data-testid="project-environment-bootstrap">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-xs" htmlFor={`${ids}-enabled`}>
            {t("enabled")}
          </Label>
          <p
            id={`${ids}-enabled-hint`}
            className="mt-0.5 text-[11px] leading-snug text-muted-foreground"
          >
            {t("description")}
          </p>
        </div>
        <Switch
          id={`${ids}-enabled`}
          aria-describedby={`${ids}-enabled-hint`}
          className="mt-0.5 shrink-0"
          checked={current.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </div>
      {current.enabled && (
        <div className="space-y-5">
          {/* A starting point, set off by a rule at its edge: applying one
              fills the fields below, it is not a field of its own. */}
          <fieldset className="space-y-3 border-l-2 pl-3">
            <legend className="mb-1 text-xs font-medium">{t("presets.title")}</legend>
            <p className="text-[11px] leading-snug text-muted-foreground">{t("presets.hint")}</p>
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
                  <NativeSelect
                    id={`${ids}-preset-${kind}`}
                    wrapperClassName="min-w-0 flex-1"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  >
                    {entries.map((entry) => (
                      <NativeSelectOption key={entry.id} value={entry.id}>
                        {t(`presets.${kind}Options.${entry.id}.label`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
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
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t(`presets.${kind}Options.${value}.description`)}
                </p>
              </div>
            ))}
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("presets.recipeHint")}
            </p>
          </fieldset>
          {current.model === "local-model" && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("presets.localModelHint")}
            </p>
          )}

          <BootstrapGroup title={t("groupTask")}>
            {textField("task")}
            <div className="grid gap-3 @md/environment-card:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-runtime`}>
                  {t("runtime")}
                </Label>
                <NativeSelect
                  id={`${ids}-runtime`}
                  wrapperClassName="w-full"
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
                  <NativeSelectOption value="native">{t("runtimeNative")}</NativeSelectOption>
                  <NativeSelectOption value="bash">{t("runtimeBash")}</NativeSelectOption>
                  <NativeSelectOption value="powershell">
                    {t("runtimePowershell")}
                  </NativeSelectOption>
                </NativeSelect>
              </div>
              {textField("binary")}
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">{t("runtimeHint")}</p>
          </BootstrapGroup>

          <BootstrapGroup title={t("groupConnection")}>
            <div className="grid gap-3 @md/environment-card:grid-cols-2">
              {connectionFields.map((field) => textField(field))}
              <div className="min-w-0 space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-auth`}>
                  {t("auth")}
                </Label>
                <NativeSelect
                  id={`${ids}-auth`}
                  wrapperClassName="w-full"
                  value={current.modelOptions?.auth ?? "bearer"}
                  onChange={(event) =>
                    updateModel({ auth: event.target.value as "bearer" | "header" | "none" })
                  }
                >
                  <NativeSelectOption value="bearer">{t("authBearer")}</NativeSelectOption>
                  <NativeSelectOption value="header">{t("authHeader")}</NativeSelectOption>
                  <NativeSelectOption value="none">{t("authNone")}</NativeSelectOption>
                </NativeSelect>
              </div>
              {current.modelOptions?.auth === "header" && (
                <div className="min-w-0 space-y-1">
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
              <div className="min-w-0 space-y-1">
                <Label className="text-xs" htmlFor={`${ids}-endpointPath`}>
                  {t("endpointPath")}
                </Label>
                <Input
                  id={`${ids}-endpointPath`}
                  value={current.modelOptions?.endpointPath ?? "chat/completions"}
                  className="font-mono text-xs"
                  onChange={(event) => updateModel({ endpointPath: event.target.value })}
                />
              </div>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">{t("credentialHint")}</p>
          </BootstrapGroup>

          <BootstrapGroup title={t("groupGeneration")}>
            <div className="grid gap-3 @md/environment-card:grid-cols-2 @2xl/environment-card:grid-cols-4">
              {(["requestTimeoutSecs", "maxTokens", "temperature", "topP"] as const).map(
                (field) => (
                  <div key={field} className="min-w-0 space-y-1">
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
                          [field]:
                            event.target.value === "" ? undefined : Number(event.target.value),
                        })
                      }
                    />
                  </div>
                )
              )}
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
            <div className="flex flex-wrap gap-x-5 gap-y-2">
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
          </BootstrapGroup>

          <BootstrapGroup title={t("checks")}>
            {current.checks.length > 0 ? (
              <ul className="divide-y border-y">
                {current.checks.map((check, index) => (
                  <li key={index} className="flex items-start gap-1.5 py-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <Input
                        value={check.name}
                        aria-label={t("checkName")}
                        placeholder={t("checkName")}
                        className="h-8"
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
                        placeholder={t("checkCommand")}
                        className="min-h-14 font-mono text-xs"
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
                        update({
                          checks: current.checks.filter((_, position) => position !== index),
                        })
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 self-start"
              disabled={current.checks.length >= 32}
              onClick={() => update({ checks: [...current.checks, { name: "", command: "" }] })}
            >
              <PlusIcon className="size-3.5" />
              {t("addCheck")}
            </Button>
            <p className="text-[11px] leading-snug text-muted-foreground">{t("checksHint")}</p>
          </BootstrapGroup>

          <BootstrapGroup title={t("groupLimits")}>
            <div className="grid gap-3 @lg/environment-card:grid-cols-3">
              {limits.map((field) => (
                <div key={field} className="min-w-0 space-y-1">
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
          </BootstrapGroup>

          {/* Native `<details>`: folded by default, but the fields stay in the
              document, so they are found by label, by find-in-page, and by
              the validation message that points at them. */}
          <details
            className="group/advanced"
            open={current.advancedOptionsDraft !== undefined ? true : undefined}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 transition-transform group-open/advanced:rotate-90"
              />
              {t("advanced")}
            </summary>
            <div className="mt-3 space-y-3 border-l-2 pl-3">
              <p className="text-[11px] leading-snug text-muted-foreground">{t("advancedHint")}</p>
              <div className="grid gap-3 @md/environment-card:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <Label className="text-xs" htmlFor={`${ids}-profile`}>
                    {t("profile")}
                  </Label>
                  <NativeSelect
                    id={`${ids}-profile`}
                    wrapperClassName="w-full"
                    value={current.tools?.profile ?? "native"}
                    onChange={(event) =>
                      updateTools({ profile: event.target.value as "native" | "dsh" })
                    }
                  >
                    <NativeSelectOption value="native">{t("profileNative")}</NativeSelectOption>
                    <NativeSelectOption value="dsh">{t("profileDsh")}</NativeSelectOption>
                  </NativeSelect>
                </div>
                <div className="min-w-0 space-y-1">
                  <Label className="text-xs" htmlFor={`${ids}-shellExecutable`}>
                    {t("shellExecutable")}
                  </Label>
                  <Input
                    id={`${ids}-shellExecutable`}
                    className="font-mono text-xs"
                    value={
                      current.tools?.shellExecutable ??
                      (current.runtime === "powershell" ? "pwsh" : "/bin/bash")
                    }
                    onChange={(event) => updateTools({ shellExecutable: event.target.value })}
                  />
                </div>
                <div className="min-w-0 space-y-1">
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
                {(["maxOutputBytes", "maxContextBytes", "maxResponseBytes"] as const).map(
                  (field) => (
                    <div key={field} className="min-w-0 space-y-1">
                      <Label className="text-xs" htmlFor={`${ids}-${field}`}>
                        {t(field)}
                      </Label>
                      <Input
                        id={`${ids}-${field}`}
                        type="number"
                        min={
                          field === "maxOutputBytes"
                            ? 256
                            : field === "maxContextBytes"
                              ? 4096
                              : 1024
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
                  )
                )}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
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
              <div className="grid gap-3 @md/environment-card:grid-cols-2">
                {(["inputs", "outputs"] as const).map((field) => (
                  <div key={field} className="min-w-0 space-y-1">
                    <Label className="text-xs" htmlFor={`${ids}-reuse-${field}`}>
                      {t(`reuse${field === "inputs" ? "Inputs" : "Outputs"}`)}
                    </Label>
                    <Textarea
                      id={`${ids}-reuse-${field}`}
                      className="font-mono text-xs"
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
              <div className="space-y-1">
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
                <p
                  id={`${ids}-advanced-help`}
                  className="text-[11px] leading-snug text-muted-foreground"
                >
                  {t("advancedSchema")}
                </p>
                {current.advancedOptionsDraft !== undefined && (
                  <p role="alert" className="text-xs text-destructive">
                    {t("validation.options")}
                  </p>
                )}
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  )
}

/**
 * One group of the bootstrap form under a small heading.
 *
 * The form is twenty-odd fields; as one flat run the endpoint sat between the
 * task and the step limit with nothing to say which belonged with which. A
 * heading per concern is enough to make it scannable, and costs no frame.
 */
function BootstrapGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </div>
  )
}
