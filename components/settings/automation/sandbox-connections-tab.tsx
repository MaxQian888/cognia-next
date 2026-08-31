"use client"

/**
 * Settings → Automation → Sandboxes (ADR-0020 remote-target). Registry UI for
 * cua desktop sandboxes: list rows with their lifecycle state and a live
 * health badge, an inline add form, and a detail sheet carrying every
 * lifecycle action.
 *
 * Lifecycle needs the desktop shell, because Docker orchestration is Rust and
 * the `cua_sandbox_*` commands are client-local. Off the desktop every action
 * is disabled with that as the stated reason, rather than hidden.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, SettingsIcon } from "lucide-react"
import { toast } from "sonner"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isTauri } from "@/lib/tauri"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import type { SandboxHealthStatus } from "@/lib/db/sandbox-connections"
import type { SandboxConnectionRow, SandboxLifecycleState } from "@/types/sandbox"
import { SandboxConnectionSheet } from "./sandbox-connection-sheet"

const DEFAULT_IMAGE = "ghcr.io/trycua/cua-xfce:latest"

function statusVariant(status: SandboxHealthStatus): "default" | "secondary" | "destructive" {
  if (status === "ok") return "default"
  if (status === "unreachable" || status === "error") return "destructive"
  return "secondary"
}

/**
 * Lifecycle state is not health. A suspended machine is perfectly fine and a
 * running one can still be unreachable, so the row shows both rather than
 * collapsing them into a single dot that answers neither question.
 */
export function stateVariant(
  state: SandboxLifecycleState
): "default" | "secondary" | "destructive" {
  if (state === "running") return "default"
  if (state === "error") return "destructive"
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
  const { connections, create, remove, provision, start, suspend, resume, stop, refreshHealth } =
    useSandboxConnections()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [image, setImage] = useState(DEFAULT_IMAGE)
  const [host, setHost] = useState("127.0.0.1")
  const [networkMode, setNetworkMode] = useState("")
  const [cpus, setCpus] = useState("")
  const [memoryMb, setMemoryMb] = useState("")
  const [workspaceHostPath, setWorkspaceHostPath] = useState("")
  const [workspaceContainerPath, setWorkspaceContainerPath] = useState("/workspace")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const desktop = isTauri()

  const statusLabel: Record<SandboxHealthStatus, string> = {
    unknown: t("statusUnknown"),
    starting: t("statusStarting"),
    ok: t("statusOk"),
    unreachable: t("statusUnreachable"),
    error: t("statusError"),
  }

  // Read from the live list rather than held in state, so an action that
  // changes the row is reflected in the open sheet without a second source of
  // truth to keep in step.
  const selected = connections.find((row) => row.id === selectedId) ?? null

  function resetForm() {
    setName("")
    setImage(DEFAULT_IMAGE)
    setHost("127.0.0.1")
    setNetworkMode("")
    setCpus("")
    setMemoryMb("")
    setWorkspaceHostPath("")
    setWorkspaceContainerPath("/workspace")
  }

  async function onCreate() {
    if (!name.trim()) return
    const parsedMemory = Number.parseInt(memoryMb, 10)
    await create({
      name: name.trim(),
      image,
      host,
      ...(networkMode.trim() ? { networkMode: networkMode.trim() } : {}),
      ...(cpus.trim() ? { cpus: cpus.trim() } : {}),
      ...(Number.isFinite(parsedMemory) && parsedMemory > 0 ? { memoryMb: parsedMemory } : {}),
      // Both halves or neither. A half-specified mount would be a guess about
      // which host directory the machine may reach.
      ...(workspaceHostPath.trim() && workspaceContainerPath.trim()
        ? {
            workspaceMount: {
              hostPath: workspaceHostPath.trim(),
              containerPath: workspaceContainerPath.trim(),
            },
          }
        : {}),
    })
    resetForm()
    setAdding(false)
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
          {connections.map((conn) => (
            <li
              key={conn.id}
              className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{conn.name}</span>
                  <Badge
                    variant={stateVariant(conn.state)}
                    data-testid={`sandbox-state-${conn.id}`}
                    data-state={conn.state}
                  >
                    {t(`state.${conn.state}`)}
                  </Badge>
                  <Badge variant={statusVariant(conn.lastHealthStatus)}>
                    {statusLabel[conn.lastHealthStatus]}
                  </Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {sandboxConnectionSummary(conn)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                data-testid={`sandbox-manage-${conn.id}`}
                onClick={() => setSelectedId(conn.id)}
              >
                <SettingsIcon className="mr-2 size-4" />
                {t("manage")}
              </Button>
            </li>
          ))}
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

            <div className="space-y-3 rounded-md border border-dashed p-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{t("policyTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("policyFrozen")}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cua-network">{t("networkMode")}</Label>
                <Input
                  id="cua-network"
                  value={networkMode}
                  placeholder={
                    /* i18n-exempt: the literal value Docker accepts for --network, not prose */ "none"
                  }
                  onChange={(e) => setNetworkMode(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("networkModeHelp")}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="cua-cpus">{t("cpus")}</Label>
                  <Input
                    id="cua-cpus"
                    value={cpus}
                    placeholder="1.5"
                    onChange={(e) => setCpus(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("cpusHelp")}</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cua-memory">{t("memoryMb")}</Label>
                  <Input
                    id="cua-memory"
                    inputMode="numeric"
                    value={memoryMb}
                    placeholder="2048"
                    onChange={(e) => setMemoryMb(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="cua-mount-host">{t("workspaceHostPath")}</Label>
                  <Input
                    id="cua-mount-host"
                    value={workspaceHostPath}
                    onChange={(e) => setWorkspaceHostPath(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cua-mount-container">{t("workspaceContainerPath")}</Label>
                  <Input
                    id="cua-mount-container"
                    value={workspaceContainerPath}
                    onChange={(e) => setWorkspaceContainerPath(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("workspaceMountHelp")}</p>
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

      <SandboxConnectionSheet
        connection={selected}
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedId(null)
        }}
        desktop={desktop}
        actions={{ provision, start, suspend, resume, stop, refreshHealth, remove }}
        onError={(message) => toast.error(message)}
        onDeleted={() => setSelectedId(null)}
      />
    </Card>
  )
}
