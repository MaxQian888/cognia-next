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
 *
 * `framed` decides who owns the frame. In Settings the registry is a section
 * of its own and draws its Card. The device console embeds the same registry
 * as one chapter of a machine's record, whose heading already names it, so it
 * renders bare there: a Card inside a titled section is two headers and two
 * borders for one thing. Row layout sizes off the registry's own width
 * (`@container/sandbox-registry`), not the viewport, because the two hosts
 * give it very different widths on the same monitor.
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
import { cn } from "@/lib/utils"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import { DEFAULT_DOCKER_SANDBOX_IMAGE } from "@/lib/sandbox/docker-adapter"
import { hasSandboxAdapter } from "@/lib/sandbox/adapter-registry"
import type { SandboxHealthStatus } from "@/lib/db/sandbox-connections"
import type { SandboxConnectionRow, SandboxLifecycleState } from "@/types/sandbox"
import { SandboxConnectionSheet } from "./sandbox-connection-sheet"

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

export interface SandboxConnectionsTabProps {
  /**
   * Draw the registry's own Card, title and description (Settings). `false`
   * when the host already titles it, as the device console's section does.
   */
  framed?: boolean
}

export function SandboxConnectionsTab({ framed = true }: SandboxConnectionsTabProps = {}) {
  const t = useTranslations("automation.sandboxConnections")
  const { connections, create, remove, provision, start, suspend, resume, stop, refreshHealth } =
    useSandboxConnections()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [image, setImage] = useState(DEFAULT_DOCKER_SANDBOX_IMAGE)
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
    setImage(DEFAULT_DOCKER_SANDBOX_IMAGE)
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

  const content = (
    <div className="@container/sandbox-registry space-y-4">
      {framed ? null : (
        <p className="text-[11px] leading-snug text-muted-foreground">{t("description")}</p>
      )}
      {connections.length === 0 && !adding ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : null}

      {connections.length > 0 ? (
        <ul
          className={framed ? "space-y-2" : "divide-y border-y"}
          data-testid="sandbox-connection-list"
        >
          {connections.map((conn) => (
            <li
              key={conn.id}
              className={cn(
                "flex flex-col gap-3 @md/sandbox-registry:flex-row @md/sandbox-registry:items-center @md/sandbox-registry:justify-between",
                framed ? "rounded-md border p-3" : "py-2.5"
              )}
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
                  {/*
                    `cua-cloud` and `lume` are declared in the provider union
                    and absent from `ADAPTERS`: documentation is not an
                    implementation, and ADR-0020 records both as deferred. A
                    row for one is formattable and unusable, so it says so
                    rather than presenting a full set of controls that every
                    one of them would refuse.
                  */}
                  {hasSandboxAdapter(conn) ? null : (
                    <Badge variant="outline" data-testid={`sandbox-no-adapter-${conn.id}`}>
                      {t("noAdapter")}
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {sandboxConnectionSummary(conn)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 self-start @md/sandbox-registry:self-auto"
                data-testid={`sandbox-manage-${conn.id}`}
                onClick={() => setSelectedId(conn.id)}
              >
                <SettingsIcon className="mr-2 size-4" />
                {t("manage")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <div
          className={cn("space-y-3", framed ? "rounded-md border p-3" : "border-t pt-3")}
          data-testid="sandbox-add-form"
        >
          <div className="space-y-1">
            <Label htmlFor="cua-name">{t("name")}</Label>
            <Input id="cua-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cua-image">{t("image")}</Label>
            <Input id="cua-image" value={image} onChange={(e) => setImage(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("imageHelp")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cua-host">{t("host")}</Label>
            <Input id="cua-host" value={host} onChange={(e) => setHost(e.target.value)} />
          </div>

          {/* The frozen policy is one group, set off by a rule at its edge
              rather than a box inside the form's box. */}
          <div className="space-y-3 border-l-2 pl-3">
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
            <div className="grid gap-3 @md/sandbox-registry:grid-cols-2">
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
            <div className="grid gap-3 @md/sandbox-registry:grid-cols-2">
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
        <Button variant="outline" size={framed ? "default" : "sm"} onClick={() => setAdding(true)}>
          <PlusIcon className="mr-2 size-4" />
          {t("addConnection")}
        </Button>
      )}

      <SandboxConnectionSheet
        connection={selected}
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedId(null)
        }}
        desktop={desktop}
        actions={{ provision, start, suspend, resume, stop, refreshHealth, remove }}
        onError={(message) => toast.error(message)}
        onDeleted={(id) => setSelectedId((current) => (current === id ? null : current))}
      />
    </div>
  )

  if (!framed) return content

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  )
}
