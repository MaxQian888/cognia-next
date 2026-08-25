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

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, DownloadIcon, PackageIcon, ServerCogIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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

export function PluginPythonHostSettings({
  pluginId,
  pythonDependencies = [],
}: {
  pluginId: string
  /** manifest.pythonDependencies — drives the install-deps consent block. */
  pythonDependencies?: string[]
}) {
  const t = useTranslations("plugins.detail.pythonHost")

  const [interpreterPath, setInterpreterPath] = useState("")
  const [envText, setEnvText] = useState("")
  const [callTimeoutMs, setCallTimeoutMs] = useState("")
  const [useVenv, setUseVenv] = useState(true)
  const [idleShutdownMin, setIdleShutdownMin] = useState("")
  const [maxConcurrentCalls, setMaxConcurrentCalls] = useState("")
  const [maxOutboundHostCalls, setMaxOutboundHostCalls] = useState("")
  const [installerKind, setInstallerKind] = useState<InstallerKind>("auto")
  const [installerPath, setInstallerPath] = useState("")
  const [createArgsText, setCreateArgsText] = useState("")
  const [installArgsText, setInstallArgsText] = useState("")
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("default")
  /** The installer that was persisted when the card loaded, for the switch warning. */
  const [savedInstallerKind, setSavedInstallerKind] = useState<InstallerKind>("auto")
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
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
        setInterpreterPath(settings?.interpreterPath ?? "")
        setEnvText(envToText(settings?.env))
        setCallTimeoutMs(settings?.callTimeoutMs != null ? String(settings.callTimeoutMs) : "")
        setUseVenv(settings?.useVenv !== false)
        setIdleShutdownMin(
          settings?.idleShutdownMin != null ? String(settings.idleShutdownMin) : ""
        )
        setMaxConcurrentCalls(
          settings?.maxConcurrentCalls != null ? String(settings.maxConcurrentCalls) : ""
        )
        setMaxOutboundHostCalls(
          settings?.maxOutboundHostCalls != null ? String(settings.maxOutboundHostCalls) : ""
        )
        const kind = (settings?.installer?.kind ?? "auto") as InstallerKind
        setInstallerKind(kind)
        setSavedInstallerKind(kind)
        setInstallerPath(settings?.installer?.path ?? "")
        setCreateArgsText((settings?.installer?.createArgs ?? []).join("\n"))
        setInstallArgsText((settings?.installer?.installArgs ?? []).join("\n"))
        setScopeChoice(settings?.venvScope ?? "default")
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

  const envValid = useMemo(() => parseEnvText(envText) !== null, [envText])

  // A custom installer that cannot create or install is refused by the host at
  // provision time; refusing it here means the user finds out while looking at
  // the field rather than three clicks later inside an install log.
  const customValid = useMemo(() => {
    if (installerKind !== "custom") return true
    return installerPath.trim() !== "" && parseArgvText(installArgsText).length > 0
  }, [installerKind, installerPath, installArgsText])

  const installerChanged = installerKind !== savedInstallerKind

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
    setSaving(true)
    try {
      await setPythonHostSettings(pluginId, settings)
      setSavedInstallerKind(installerKind)
      setSavedTick(true)
      setTimeout(() => setSavedTick(false), 2000)
    } finally {
      setSaving(false)
    }
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
    <Card className="p-4 space-y-4" data-testid="python-host-settings">
      <div className="flex items-center gap-2">
        <ServerCogIcon className="size-4 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-medium">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`py-interpreter-${pluginId}`}>{t("interpreterPath")}</Label>
          <Input
            id={`py-interpreter-${pluginId}`}
            value={interpreterPath}
            onChange={(e) => setInterpreterPath(e.target.value)}
            placeholder={t("interpreterPathPlaceholder")}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`py-env-${pluginId}`}>{t("env")}</Label>
          <Textarea
            id={`py-env-${pluginId}`}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
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
            onChange={(e) => setCallTimeoutMs(e.target.value)}
            placeholder="120000"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`py-idle-${pluginId}`}>{t("idleShutdownMin")}</Label>
          <Input
            id={`py-idle-${pluginId}`}
            type="number"
            min={0}
            value={idleShutdownMin}
            onChange={(e) => setIdleShutdownMin(e.target.value)}
            placeholder="0"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`py-concurrency-${pluginId}`}>{t("maxConcurrentCalls")}</Label>
          <Input
            id={`py-concurrency-${pluginId}`}
            type="number"
            min={1}
            value={maxConcurrentCalls}
            onChange={(e) => setMaxConcurrentCalls(e.target.value)}
            placeholder="4"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`py-outbound-${pluginId}`}>{t("maxOutboundHostCalls")}</Label>
          <Input
            id={`py-outbound-${pluginId}`}
            type="number"
            min={1}
            value={maxOutboundHostCalls}
            onChange={(e) => setMaxOutboundHostCalls(e.target.value)}
            placeholder="8"
          />
          <p className="text-xs text-muted-foreground">{t("maxOutboundHostCallsHint")}</p>
        </div>

        <div className="flex items-center gap-2 pt-5">
          <Switch
            id={`py-venv-${pluginId}`}
            checked={useVenv}
            onCheckedChange={(checked) => setUseVenv(checked === true)}
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
            <span>{t("environment.interpreterVersion", { version: pythonVersion ?? "—" })}</span>
            {uvVersion ? (
              <span>{t("environment.uvPresent", { version: uvVersion })}</span>
            ) : (
              <>
                <span>{t("environment.uvMissing")}</span>
                <Button
                  size="sm"
                  variant="outline"
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

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`py-installer-${pluginId}`}>{t("environment.installer")}</Label>
            <Select
              value={installerKind}
              onValueChange={(value) => setInstallerKind(value as InstallerKind)}
            >
              <SelectTrigger
                id={`py-installer-${pluginId}`}
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
              onValueChange={(value) => setScopeChoice(value as ScopeChoice)}
            >
              <SelectTrigger id={`py-scope-${pluginId}`} aria-label={t("environment.scope")}>
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
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`py-installer-path-${pluginId}`}>
                {t("environment.installerPath")}
              </Label>
              <Input
                id={`py-installer-path-${pluginId}`}
                value={installerPath}
                onChange={(e) => setInstallerPath(e.target.value)}
                placeholder={t("environment.installerPathPlaceholder")}
              />
            </div>
          )}

          {installerKind === "custom" && (
            <>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`py-create-args-${pluginId}`}>{t("environment.createArgs")}</Label>
                <Textarea
                  id={`py-create-args-${pluginId}`}
                  value={createArgsText}
                  onChange={(e) => setCreateArgsText(e.target.value)}
                  placeholder={
                    /* i18n-exempt: literal argv for `python -m venv`, plus the host's own substitution tokens */
                    "venv\n--python\n{python}\n{venv}"
                  }
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">{t("environment.createArgsHint")}</p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`py-install-args-${pluginId}`}>
                  {t("environment.installArgs")}
                </Label>
                <Textarea
                  id={`py-install-args-${pluginId}`}
                  value={installArgsText}
                  onChange={(e) => setInstallArgsText(e.target.value)}
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
              <p className="sm:col-span-2 text-xs text-muted-foreground">
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

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("applyHint")}</p>
        <div className="flex items-center gap-2">
          {savedTick && (
            <span className="text-xs text-muted-foreground" role="status">
              {t("saved")}
            </span>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || !envValid || !customValid}>
            {t("save")}
          </Button>
        </div>
      </div>

      {pythonDependencies.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("deps.summary", { count: pythonDependencies.length })}
          </p>
          <p className="text-xs font-mono break-all">{pythonDependencies.join(", ")}</p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={installing}>
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
              className="rounded-md border bg-muted/40 p-2 space-y-1"
              data-testid="py-install-outcome"
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
    </Card>
  )
}
