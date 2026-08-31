"use client"

/**
 * Settings → Automation → Sandboxes (ADR-0020 remote-target). Registry UI for
 * cua desktop sandboxes: list rows with a live health badge, start / stop /
 * check / delete lifecycle, and an inline add form. Lifecycle buttons need the
 * desktop shell (Docker orchestration is Rust) so they're disabled in web mode.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, PlayIcon, SquareIcon, ActivityIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isTauri } from "@/lib/tauri"
import { supportsSandboxOperation } from "@/lib/sandbox/connection-capabilities"
import { projectSandboxConnectionCapabilities } from "@/lib/sandbox/runtime-availability"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import type { SandboxHealthStatus } from "@/lib/db/sandbox-connections"
import type { SandboxConnectionRow, SandboxLifecycleOperation } from "@/types/sandbox"

const DEFAULT_IMAGE = "ghcr.io/trycua/cua-xfce:latest"

function statusVariant(status: SandboxHealthStatus): "default" | "secondary" | "destructive" {
  if (status === "ok") return "default"
  if (status === "unreachable" || status === "error") return "destructive"
  return "secondary"
}

export function sandboxConnectionSummary(connection: SandboxConnectionRow): string {
  const config = connection.config
  switch (config.provider) {
    case "docker":
      return `${config.image} · ${config.host}${config.port ? `:${config.port}` : ""}`
    case "cua-cloud": {
      const endpoint = config.apiHost ?? config.host
      return `${config.instanceName}${endpoint ? ` · ${endpoint}${config.port ? `:${config.port}` : ""}` : ""}`
    }
    case "lume":
      return `${config.vmName}${config.image ? ` · ${config.image}` : ""}`
  }
}

export function SandboxConnectionsTab() {
  const t = useTranslations("automation.sandboxConnections")
  const { connections, create, remove, start, stop, refreshHealth } = useSandboxConnections()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [image, setImage] = useState(DEFAULT_IMAGE)
  const [host, setHost] = useState("127.0.0.1")
  const desktop = isTauri()

  const statusLabel: Record<SandboxHealthStatus, string> = {
    unknown: t("statusUnknown"),
    starting: t("statusStarting"),
    ok: t("statusOk"),
    unreachable: t("statusUnreachable"),
    error: t("statusError"),
  }

  async function onCreate() {
    if (!name.trim()) return
    await create({ name: name.trim(), image, host })
    setName("")
    setImage(DEFAULT_IMAGE)
    setHost("127.0.0.1")
    setAdding(false)
  }

  async function run(action: () => Promise<void>) {
    try {
      await action()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connections.length === 0 && !adding ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}

        <ul className="space-y-2">
          {connections.map((conn) => {
            const liveCapabilities = projectSandboxConnectionCapabilities(conn, desktop)
            const actionAvailable = (operation: SandboxLifecycleOperation) =>
              supportsSandboxOperation(liveCapabilities, operation)
            const actionTitle = (operation: SandboxLifecycleOperation, label: string) =>
              actionAvailable(operation)
                ? label
                : desktop
                  ? t("unsupportedAction")
                  : t("desktopOnly")
            return (
              <li
                key={conn.id}
                className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{conn.name}</span>
                    <Badge variant={statusVariant(conn.lastHealthStatus)}>
                      {statusLabel[conn.lastHealthStatus]}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {sandboxConnectionSummary(conn)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!actionAvailable("start")}
                    title={actionTitle("start", t("start"))}
                    aria-label={t("start")}
                    onClick={() => run(() => start(conn.id))}
                  >
                    <PlayIcon className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!actionAvailable("stop")}
                    title={actionTitle("stop", t("stop"))}
                    aria-label={t("stop")}
                    onClick={() => run(() => stop(conn.id))}
                  >
                    <SquareIcon className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!actionAvailable("health")}
                    title={actionTitle("health", t("checkHealth"))}
                    aria-label={t("checkHealth")}
                    onClick={() => run(() => refreshHealth(conn.id))}
                  >
                    <ActivityIcon className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!actionAvailable("delete")}
                    aria-label={t("delete")}
                    title={actionTitle("delete", t("delete"))}
                    onClick={() => run(() => remove(conn.id))}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>

        {adding ? (
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="cua-name">{t("name")}</Label>
              <Input id="cua-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cua-image">{t("image")}</Label>
              <Input id="cua-image" value={image} onChange={(e) => setImage(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cua-host">{t("host")}</Label>
              <Input id="cua-host" value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>
                {t("cancel")}
              </Button>
              <Button onClick={onCreate} disabled={!name.trim()}>
                {t("save")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon className="mr-2 size-4" />
            {t("addConnection")}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
