"use client"

// Host-level runtime settings card for python/hybrid plugins — rendered at
// the top of the Configure sub-tab, above the manifest configSchema form.
// These knobs configure the HOST PROCESS (interpreter, env, timeouts, idle
// shutdown), not the plugin's own config; they persist on the Dexie plugins
// row and apply on the next (re)load of the host.
//
// The card also owns the dependency-install consent flow: pip installs hit
// the network and write a venv, so they only ever run from the explicit
// confirm dialog here (progress streams into the Logs tab).

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, ServerCogIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import type { PythonHostSettings } from "@/types/plugin"

const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/

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
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

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
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId])

  const envValid = useMemo(() => parseEnvText(envText) !== null, [envText])

  const handleSave = async () => {
    const env = parseEnvText(envText)
    if (env === null) return
    setSaving(true)
    try {
      const settings: PythonHostSettings = {
        interpreterPath: interpreterPath.trim() || undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        callTimeoutMs: parseOptionalInt(callTimeoutMs),
        useVenv: useVenv ? undefined : false,
        idleShutdownMin: parseOptionalInt(idleShutdownMin),
        maxConcurrentCalls: parseOptionalInt(maxConcurrentCalls),
      }
      await setPythonHostSettings(pluginId, settings)
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
      await getPluginManager().installPythonDeps(pluginId, pythonDependencies)
    } catch (error) {
      setInstallError(String(error))
    } finally {
      setInstalling(false)
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
            placeholder="API_KEY=value"
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

        <div className="flex items-center gap-2 pt-5">
          <Switch
            id={`py-venv-${pluginId}`}
            checked={useVenv}
            onCheckedChange={(checked) => setUseVenv(checked === true)}
          />
          <Label htmlFor={`py-venv-${pluginId}`}>{t("useVenv")}</Label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("applyHint")}</p>
        <div className="flex items-center gap-2">
          {savedTick && (
            <span className="text-xs text-muted-foreground" role="status">
              {t("saved")}
            </span>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || !envValid}>
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
        </div>
      )}
    </Card>
  )
}
