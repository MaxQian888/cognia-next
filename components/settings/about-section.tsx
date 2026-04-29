"use client"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useEffect, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { getOsInfo, type OsInfo } from "@/lib/tauri/os"
import { toast } from "sonner"
import { DownloadIcon, RefreshCwIcon, RocketIcon } from "lucide-react"

export function AboutSection() {
  const [version, setVersion] = useState<string>("")
  const [name, setName] = useState<string>("")
  const [checking, setChecking] = useState(false)
  const [available, setAvailable] = useState<{
    version: string
    body?: string
  } | null>(null)
  const [osInfo, setOsInfo] = useState<OsInfo | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void Promise.all([
      import("@tauri-apps/api/app").then((m) => m.getVersion()),
      import("@tauri-apps/api/app").then((m) => m.getName()),
      getOsInfo(),
    ])
      .then(([v, n, info]) => {
        if (!cancelled) {
          setVersion(v)
          setName(n)
          setOsInfo(info)
        }
      })
      .catch((err) => console.warn("getVersion/getName/os failed", err))
    return () => {
      cancelled = true
    }
  }, [])

  const handleCheck = async () => {
    if (!isTauri()) {
      toast.info("Updates are only available in the desktop build.")
      return
    }
    setChecking(true)
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        toast.success("You're on the latest version.")
        setAvailable(null)
        return
      }
      setAvailable({ version: update.version, body: update.body })
      toast.success(`Update available: ${update.version}`)
    } catch (err) {
      toast.error(`Update check failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async () => {
    if (!isTauri() || !available) return
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        toast.info("Update no longer available.")
        return
      }
      await update.downloadAndInstall()
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
    } catch (err) {
      toast.error(`Update install failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <RocketIcon className="size-4" />
          About
        </Label>
        <p className="text-xs text-muted-foreground">
          {name ? `${name} ` : ""}version{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">{version || "—"}</code>
          {!isTauri() && " (web preview)"}
        </p>
        {osInfo && (
          <p className="text-[11px] text-muted-foreground">
            Running on{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {osInfo.osType} {osInfo.version}
            </code>{" "}
            ({osInfo.arch})
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button onClick={handleCheck} disabled={checking}>
          {checking ? (
            <>
              <RefreshCwIcon className="mr-2 size-4 animate-spin" />
              Checking…
            </>
          ) : (
            <>
              <RefreshCwIcon className="mr-2 size-4" />
              Check for updates
            </>
          )}
        </Button>
        {available && (
          <Button variant="default" onClick={handleInstall}>
            <DownloadIcon className="mr-2 size-4" />
            Install {available.version}
          </Button>
        )}
      </div>

      {available && (
        <Alert>
          <AlertTitle className="text-sm">Update {available.version} available</AlertTitle>
          {available.body && (
            <AlertDescription className="whitespace-pre-wrap text-xs">
              {available.body}
            </AlertDescription>
          )}
        </Alert>
      )}
    </div>
  )
}
