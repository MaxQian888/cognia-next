"use client"

// Host-level runtime settings card for python/hybrid plugins — rendered at
// the top of the Configure sub-tab, above the manifest configSchema form.
// These knobs configure the HOST PROCESS (interpreter, env, timeouts, idle
// shutdown, the outbound RPC gate), not the plugin's own config; they persist
// on the Dexie plugins row and apply on the next (re)load of the host.
//
// The card also owns the environment: which installer provisions it, whether
// it is shared with other Python plugins, and the dependency-install consent
// flow. Installs hit the network and write a venv, so they only ever run from
// the explicit confirm dialog here (progress streams into the Logs tab), and
// the outcome — including the reason a shared environment was downgraded to
// an isolated one — is reported back into this card (ADR-0145).
//
// Save / Reset track a baseline the same way the config form below does:
// Save is enabled only once something changed (and the input is valid), and
// Reset restores the last saved values. Layout follows the component's own
// width (`@container` + `@md:`), not the viewport: in a 320px pane on a wide
// screen a viewport `sm:` grid squeezed two inputs side by side.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, DownloadIcon, PackageIcon, ServerCogIcon } from "lucide-react"
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { getPythonHostSettings, setPythonHostSettings } from "@/lib/db/plugins"
import type { PythonHostSettings, PythonInstallOutcome } from "@/types/plugin"

const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/

/** `auto` is the stored absence of a choice; the Select needs a real value. */
type InstallerKind = "auto" | "uv" | "pip" | "custom"
/** `default` means "whatever the manifest asked for" — also a stored absence. */
type ScopeChoice = "default" | "shared" | "isolated"

function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

/** Parse KEY=VALUE lines; returns null when any non-empty line is invalid. */
function parseEnvText(text: string): Record<string, string> | null {
  const env: Record<string, string> = {}
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    if (!ENV_LINE.test(line)) return null
    const eq = line.indexOf("=")
    env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

function parseOptionalInt(value: string): number | undefined {
  if (value.trim() === "") return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * One argv element per line. Whitespace is never a separator here: a template
 * argument is routinely a path with spaces, and splitting on them would break
 * exactly the installers a custom template exists to reach.
 */
function parseArgvText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The editable fields, as typed. Compared field by field for dirty state. */
export interface PythonHostForm {
  interpreterPath: string
  envText: string
  callTimeoutMs: string
  useVenv: boolean
  idleShutdownMin: string
  maxConcurrentCalls: string
  maxOutboundHostCalls: string
  installerKind: InstallerKind
  installerPath: string
  createArgsText: string
  installArgsText: string
  scopeChoice: ScopeChoice
}

const EMPTY_FORM: PythonHostForm = {
  interpreterPath: "",
  envText: "",
  callTimeoutMs: "",
  useVenv: true,
  idleShutdownMin: "",
  maxConcurrentCalls: "",
  maxOutboundHostCalls: "",
  installerKind: "auto",
  installerPath: "",
  createArgsText: "",
  installArgsText: "",
  scopeChoice: "default",
}

const optionalIntText = (value: number | undefined): string => (value != null ? String(value) : "")

/** Persisted settings → the form's text fields. */
export function settingsToForm(settings: PythonHostSettings | undefined): PythonHostForm {
  return {
    interpreterPath: settings?.interpreterPath ?? "",
    envText: envToText(settings?.env),
    callTimeoutMs: optionalIntText(settings?.callTimeoutMs),
    useVenv: settings?.useVenv !== false,
    idleShutdownMin: optionalIntText(settings?.idleShutdownMin),
    maxConcurrentCalls: optionalIntText(settings?.maxConcurrentCalls),
    maxOutboundHostCalls: optionalIntText(settings?.maxOutboundHostCalls),
    installerKind: (settings?.installer?.kind ?? "auto") as InstallerKind,
    installerPath: settings?.installer?.path ?? "",
    createArgsText: (settings?.installer?.createArgs ?? []).join("\n"),
    installArgsText: (settings?.installer?.installArgs ?? []).join("\n"),
    scopeChoice: settings?.venvScope ?? "default",
  }
}

export function formsEqual(a: PythonHostForm, b: PythonHostForm): boolean {
  return (Object.keys(a) as (keyof PythonHostForm)[]).every((key) => a[key] === b[key])
}

/** How long the "Saved" confirmation stays up. */
const SAVED_TICK_MS = 2000

export function PluginPythonHostSettings({
  pluginId,
  pythonDependencies = [],
}: {
  pluginId: string
  /** manifest.pythonDependencies — drives the install-deps consent block. */
  pythonDependencies?: string[]
}) {
  const t = useTranslations("plugins.detail.pythonHost")

  const [form, setForm] = useState<PythonHostForm>(EMPTY_FORM)
  /** What is persisted: the dirty baseline, the Reset target, the switch-warning reference. */
  const [baseline, setBaseline] = useState<PythonHostForm>(EMPTY_FORM)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedTickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installOutcome, setInstallOutcome] = useState<PythonInstallOutcome | null>(null)
  const [uvVersion, setUvVersion] = useState<string | null>(null)
  const [pythonVersion, setPythonVersion] = useState<string | null>(null)
  /** Null until the runtime answers; stays null off Tauri, where it has none. */
  const [runtimeProbed, setRuntimeProbed] = useState(false)
  const [installingUv, setInstallingUv] = useState(false)
  const [uvError, setUvError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const settings = await getPythonHostSettings(pluginId)
        if (cancelled) return
        const loadedForm = settingsToForm(settings)
        setForm(loadedForm)
        setBaseline(loadedForm)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId])

  // Interpreter + uv presence. Off Tauri there is no native host at all, so a
  // failure here means "nothing to report", never "the runtime is broken".
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        const info = await getPluginManager().getPythonRuntimeInfo()
        if (cancelled) return
        setPythonVersion(info?.version ?? null)
        setUvVersion(info?.uv_version ?? null)
        setRuntimeProbed(Boolean(info?.available))
      } catch {
        if (!cancelled) setRuntimeProbed(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId])

  // The "Saved" confirmation clears itself; never let that timer fire into an
  // unmounted card (the pane switches tabs and plugins freely).
  useEffect(
    () => () => {
      if (savedTickTimer.current !== null) clearTimeout(savedTickTimer.current)
    },
    []
  )

  const update = useCallback(<K extends keyof PythonHostForm>(key: K, value: PythonHostForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const {
    interpreterPath,
    envText,
    callTimeoutMs,
    useVenv,
    idleShutdownMin,
    maxConcurrentCalls,
    maxOutboundHostCalls,
    installerKind,
    installerPath,
    createArgsText,
    installArgsText,
    scopeChoice,
  } = form

  const dirty = !formsEqual(form, baseline)
  const envValid = useMemo(() => parseEnvText(envText) !== null, [envText])

  // A custom installer that cannot create or install is refused by the host at
  // provision time; refusing it here means the user finds out while looking at
  // the field rather than three clicks later inside an install log.
  const customValid = useMemo(() => {
    if (installerKind !== "custom") return true
    return installerPath.trim() !== "" && parseArgvText(installArgsText).length > 0
  }, [installerKind, installerPath, installArgsText])

  const installerChanged = installerKind !== baseline.installerKind

  const buildSettings = useCallback((): PythonHostSettings | null => {
    const env = parseEnvText(envText)
    if (env === null) return null
    const createArgs = parseArgvText(createArgsText)
    const installArgs = parseArgvText(installArgsText)
    const installerPathValue = installerPath.trim()
    const wantsInstaller =
      installerKind !== "auto" ||
      installerPathValue !== "" ||
      createArgs.length > 0 ||
      installArgs.length > 0
    return {
      interpreterPath: interpreterPath.trim() || undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      callTimeoutMs: parseOptionalInt(callTimeoutMs),
      useVenv: useVenv ? undefined : false,
      idleShutdownMin: parseOptionalInt(idleShutdownMin),
      maxConcurrentCalls: parseOptionalInt(maxConcurrentCalls),
      maxOutboundHostCalls: parseOptionalInt(maxOutboundHostCalls),
      installer: wantsInstaller
        ? {
            kind: installerKind,
            path: installerPathValue || undefined,
            createArgs: createArgs.length > 0 ? createArgs : undefined,
            installArgs: installArgs.length > 0 ? installArgs : undefined,
          }
        : undefined,
      venvScope: scopeChoice === "default" ? undefined : scopeChoice,
    }
  }, [
    envText,
    createArgsText,
    installArgsText,
    installerPath,
    installerKind,
    interpreterPath,
    callTimeoutMs,
    useVenv,
    idleShutdownMin,
    maxConcurrentCalls,
    maxOutboundHostCalls,
    scopeChoice,
  ])

  const handleSave = async () => {
    const settings = buildSettings()
    if (settings === null || !customValid) return
    const savedForm = form
    setSaving(true)
    setSaveError(null)
    try {
      await setPythonHostSettings(pluginId, settings)
      setBaseline(savedForm)
      setSavedTick(true)
      if (savedTickTimer.current !== null) clearTimeout(savedTickTimer.current)
      savedTickTimer.current = setTimeout(() => {
        savedTickTimer.current = null
        setSavedTick(false)
      }, SAVED_TICK_MS)
    } catch (error) {
      // The form stays dirty, so the user can retry or reset.
      setSaveError(String(error))
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setForm(baseline)
    setSaveError(null)
  }

  const handleInstallDeps = async () => {
    setInstalling(true)
    setInstallError(null)
    try {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      const outcome = await getPluginManager().installPythonDeps(pluginId, pythonDependencies)
      setInstallOutcome(outcome ?? null)
    } catch (error) {
      setInstallError(String(error))
    } finally {
      setInstalling(false)
    }
  }

  const handleInstallUv = async () => {
    setInstallingUv(true)
    setUvError(null)
    try {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      const version = await getPluginManager().installUv()
      setUvVersion(version)
    } catch (error) {
      setUvError(String(error))
    } finally {
      setInstallingUv(false)
    }
  }

  if (!loaded) {
    return null
  }

  return (
    <div className="@container min-w-0 space-y-3" data-testid="python-host-settings">
      <div className="flex items-center gap-2">
        <ServerCogIcon className="size-4 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-medium">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <div className="grid gap-3 @md:grid-cols-2">
        <div className="space-y-1.5 @md:col-span-2">
          <Label htmlFor={`py-interpreter-${pluginId}`}>{t("interpreterPath")}</Label>
          <Input
            id={`py-interpreter-${pluginId}`}
            value={interpreterPath}
            onChange={(e) => update("interpreterPath", e.target.value)}
            placeholder={t("interpreterPathPlaceholder")}
          />
        </div>

        <div className="space-y-1.5 @md:col-span-2">
          <Label htmlFor={`py-env-${pluginId}`}>{t("env")}</Label>
          <Textarea
            id={`py-env-${pluginId}`}
            value={envText}
            onChange={(e) => update("envText", e.target.value)}
            placeholder={
              /* i18n-exempt: KEY=VALUE is the literal env-file syntax */ "API_KEY=value"
            }
            rows={3}
            aria-invalid={!envValid}
          />
          <p className={envValid ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
            {envValid ? t("envHint") : t("envInvalid")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`py-timeout-${pluginId}`}>{t("callTimeoutMs")}</Label>
          <Input
            id={`py-timeout-${pluginId}`}
            type="number"
            min={1000}
            value={callTimeoutMs}
            onChange={(e) => update("callTimeoutMs", e.target.value)}
            placeholder={/* i18n-exempt: numeric example (the default timeout) */ "120000"}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`py-idle-${pluginId}`}>{t("idleShutdownMin")}</Label>
          <Input
            id={`py-idle-${pluginId}`}
            type="number"
            min={0}
            value={idleShutdownMin}
            onChange={(e) => update("idleShutdownMin", e.target.value)}
            placeholder={/* i18n-exempt: numeric example */ "0"}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`py-concurrency-${pluginId}`}>{t("maxConcurrentCalls")}</Label>
          <Input
            id={`py-concurrency-${pluginId}`}
            type="number"
            min={1}
            value={maxConcurrentCalls}
            onChange={(e) => update("maxConcurrentCalls", e.target.value)}
            placeholder={/* i18n-exempt: numeric example */ "4"}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`py-outbound-${pluginId}`}>{t("maxOutboundHostCalls")}</Label>
          <Input
            id={`py-outbound-${pluginId}`}
            type="number"
            min={1}
            value={maxOutboundHostCalls}
            onChange={(e) => update("maxOutboundHostCalls", e.target.value)}
            placeholder={/* i18n-exempt: numeric example */ "8"}
          />
          <p className="text-xs text-muted-foreground">{t("maxOutboundHostCallsHint")}</p>
        </div>

        <div className="flex items-center gap-2 @md:pt-5">
          <Switch
            id={`py-venv-${pluginId}`}
            checked={useVenv}
            onCheckedChange={(checked) => update("useVenv", checked === true)}
          />
          <Label htmlFor={`py-venv-${pluginId}`}>{t("useVenv")}</Label>
        </div>
      </div>

      <div className="border-t pt-3 space-y-3">
        <div className="flex items-center gap-2">
          <PackageIcon className="size-4 text-muted-foreground" />
          <div>
            <h4 className="text-sm font-medium">{t("environment.title")}</h4>
            <p className="text-xs text-muted-foreground">{t("environment.description")}</p>
          </div>
        </div>

        {runtimeProbed && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t("environment.interpreterVersion", {
                version: pythonVersion ?? t("environment.versionUnknown"),
              })}
            </span>
            {uvVersion ? (
              <span>{t("environment.uvPresent", { version: uvVersion })}</span>
            ) : (
              <>
                <span>{t("environment.uvMissing")}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="pointer-coarse:h-10"
                  onClick={handleInstallUv}
                  disabled={installingUv}
                >
                  {installingUv ? t("environment.uvInstalling") : t("environment.uvInstall")}
                </Button>
              </>
            )}
          </div>
        )}
        {uvError && (
          <p className="text-xs text-destructive" role="alert">
            {t("environment.uvError", { message: uvError })}
          </p>
        )}

        <div className="grid gap-3 @md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`py-installer-${pluginId}`}>{t("environment.installer")}</Label>
            <Select
              value={installerKind}
              onValueChange={(value) => update("installerKind", value as InstallerKind)}
            >
              <SelectTrigger
                id={`py-installer-${pluginId}`}
                className="w-full pointer-coarse:h-10"
                aria-label={t("environment.installer")}
                aria-describedby={installerChanged ? `py-installer-switch-${pluginId}` : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("environment.installerAuto")}</SelectItem>
                <SelectItem value="uv">{t("environment.installerUv")}</SelectItem>
                <SelectItem value="pip">{t("environment.installerPip")}</SelectItem>
                <SelectItem value="custom">{t("environment.installerCustom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`py-scope-${pluginId}`}>{t("environment.scope")}</Label>
            <Select
              value={scopeChoice}
              onValueChange={(value) => update("scopeChoice", value as ScopeChoice)}
            >
              <SelectTrigger
                id={`py-scope-${pluginId}`}
                className="w-full pointer-coarse:h-10"
                aria-label={t("environment.scope")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("environment.scopeDefault")}</SelectItem>
                <SelectItem value="shared">{t("environment.scopeShared")}</SelectItem>
                <SelectItem value="isolated">{t("environment.scopeIsolated")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("environment.scopeHint")}</p>
          </div>

          {installerKind !== "pip" && installerKind !== "auto" && (
            <div className="space-y-1.5 @md:col-span-2">
              <Label htmlFor={`py-installer-path-${pluginId}`}>
                {t("environment.installerPath")}
              </Label>
              <Input
                id={`py-installer-path-${pluginId}`}
                value={installerPath}
                onChange={(e) => update("installerPath", e.target.value)}
                placeholder={t("environment.installerPathPlaceholder")}
              />
            </div>
          )}

          {installerKind === "custom" && (
            <>
              <div className="space-y-1.5 @md:col-span-2">
                <Label htmlFor={`py-create-args-${pluginId}`}>{t("environment.createArgs")}</Label>
                <Textarea
                  id={`py-create-args-${pluginId}`}
                  value={createArgsText}
                  onChange={(e) => update("createArgsText", e.target.value)}
                  placeholder={
                    /* i18n-exempt: literal argv for `python -m venv`, plus the host's own substitution tokens */
                    "venv\n--python\n{python}\n{venv}"
                  }
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">{t("environment.createArgsHint")}</p>
              </div>
              <div className="space-y-1.5 @md:col-span-2">
                <Label htmlFor={`py-install-args-${pluginId}`}>
                  {t("environment.installArgs")}
                </Label>
                <Textarea
                  id={`py-install-args-${pluginId}`}
                  value={installArgsText}
                  onChange={(e) => update("installArgsText", e.target.value)}
                  placeholder={
                    /* i18n-exempt: literal installer argv, plus the host's own substitution tokens */
                    "add\n--python\n{venvPython}\n{specs}"
                  }
                  rows={3}
                  aria-invalid={!customValid}
                />
                <p
                  className={
                    customValid ? "text-xs text-muted-foreground" : "text-xs text-destructive"
                  }
                >
                  {customValid
                    ? t("environment.installArgsHint")
                    : t("environment.customIncomplete")}
                </p>
              </div>
              <p className="@md:col-span-2 text-xs text-muted-foreground">
                {t("environment.customIsolatedNote")}
              </p>
            </>
          )}
        </div>

        {installerChanged && (
          <p
            id={`py-installer-switch-${pluginId}`}
            data-testid="installer-switch-warning"
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            {t("environment.installerSwitchWarning")}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">{t("applyHint")}</p>
        <div className="ml-auto flex items-center gap-2">
          {savedTick && (
            <span className="text-xs text-muted-foreground" role="status">
              {t("saved")}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="pointer-coarse:h-10"
            onClick={handleReset}
            disabled={saving || !dirty}
          >
            {t("reset")}
          </Button>
          <Button
            size="sm"
            className="pointer-coarse:h-10"
            onClick={handleSave}
            disabled={saving || !dirty || !envValid || !customValid}
          >
            {t("save")}
          </Button>
        </div>
        {saveError && (
          <p className="basis-full text-xs text-destructive" role="alert">
            {t("saveError", { message: saveError })}
          </p>
        )}
      </div>

      {pythonDependencies.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("deps.summary", { count: pythonDependencies.length })}
          </p>
          <p className="text-xs font-mono break-all">{pythonDependencies.join(", ")}</p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-10"
                disabled={installing}
              >
                <DownloadIcon className="size-3.5" />
                {installing ? t("deps.installing") : t("deps.install")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("deps.confirmTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deps.confirmBody", { count: pythonDependencies.length })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("deps.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={handleInstallDeps}>
                  {t("deps.confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {installError && (
            <p className="text-xs text-destructive" role="alert">
              {t("deps.error", { message: installError })}
            </p>
          )}
          {installOutcome && (
            <div
              className="space-y-1 border-l-2 border-border pl-3"
              data-testid="py-install-outcome"
              role="status"
            >
              <p className="text-xs">
                {t("deps.outcome", {
                  installer: installOutcome.installer,
                  scope: installOutcome.scope,
                })}
              </p>
              <p className="text-xs font-mono break-all text-muted-foreground">
                {installOutcome.venvDir}
              </p>
              {installOutcome.downgradedReason && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  {t("deps.downgraded", { reason: installOutcome.downgradedReason })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
