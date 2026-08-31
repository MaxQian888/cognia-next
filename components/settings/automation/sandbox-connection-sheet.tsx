"use client"

/**
 * Lifecycle detail for one sandbox connection (ADR-0020 remote-target).
 *
 * The list row carries identity and state. Everything that acts on the machine
 * lives here, because there are seven lifecycle actions and a row of seven
 * icon buttons stops being readable well before the last one.
 *
 * Every action is gated by the connection's live capability projection, so an
 * operation the provider cannot carry is visibly disabled with the reason
 * rather than offered and then refused.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { supportsSandboxOperation } from "@/lib/sandbox/connection-capabilities"
import { projectSandboxConnectionCapabilities } from "@/lib/sandbox/runtime-availability"
import type {
  DockerSandboxConfig,
  SandboxConnectionRow,
  SandboxLifecycleOperation,
} from "@/types/sandbox"

export interface SandboxConnectionActions {
  provision(id: string): Promise<void>
  start(id: string): Promise<void>
  suspend(id: string): Promise<void>
  resume(id: string): Promise<void>
  stop(id: string): Promise<void>
  refreshHealth(id: string): Promise<void>
  remove(id: string): Promise<void>
}

export interface SandboxConnectionSheetProps {
  connection: SandboxConnectionRow | null
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Whether the client-local Tauri host that owns Docker is present. */
  desktop: boolean
  actions: SandboxConnectionActions
  onError: (message: string) => void
  /** Closed after a successful delete, since the row is gone. */
  onDeleted?: () => void
}

interface ActionSpec {
  operation: SandboxLifecycleOperation
  labelKey: string
  helpKey?: string
  icon: LucideIcon
  run: (actions: SandboxConnectionActions, id: string) => Promise<void>
  destructive?: boolean
}

const ACTIONS: ActionSpec[] = [
  {
    operation: "create",
    labelKey: "provision",
    helpKey: "provisionHelp",
    icon: PlusIcon,
    run: (a, id) => a.provision(id),
  },
  { operation: "start", labelKey: "start", icon: PlayIcon, run: (a, id) => a.start(id) },
  {
    operation: "suspend",
    labelKey: "suspend",
    helpKey: "suspendHelp",
    icon: PauseIcon,
    run: (a, id) => a.suspend(id),
  },
  { operation: "resume", labelKey: "resume", icon: PlayIcon, run: (a, id) => a.resume(id) },
  {
    operation: "stop",
    labelKey: "stop",
    helpKey: "stopHelp",
    icon: SquareIcon,
    run: (a, id) => a.stop(id),
  },
  {
    operation: "health",
    labelKey: "checkHealth",
    icon: ActivityIcon,
    run: (a, id) => a.refreshHealth(id),
  },
  {
    operation: "delete",
    labelKey: "delete",
    helpKey: "deleteHelp",
    icon: Trash2Icon,
    run: (a, id) => a.remove(id),
    destructive: true,
  },
]

export function SandboxConnectionSheet({
  connection,
  open,
  onOpenChange,
  desktop,
  actions,
  onError,
  onDeleted,
}: SandboxConnectionSheetProps) {
  const t = useTranslations("automation.sandboxConnections")
  const [busy, setBusy] = useState<SandboxLifecycleOperation | null>(null)

  if (!connection) return null

  const live = projectSandboxConnectionCapabilities(connection, desktop)
  const docker = connection.config.provider === "docker" ? connection.config : null

  async function run(spec: ActionSpec) {
    if (!connection) return
    setBusy(spec.operation)
    try {
      await spec.run(actions, connection.id)
      if (spec.operation === "delete") {
        onOpenChange(false)
        onDeleted?.()
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={connection.name}
      description={t(`state.${connection.state}`)}
    >
      <div className="space-y-5 overflow-y-auto px-4 pb-6" data-testid="sandbox-connection-detail">
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("lifecycleTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("persistsAfterQuit")}</p>
          <div className="grid gap-2">
            {ACTIONS.map((spec) => {
              const allowed = supportsSandboxOperation(live, spec.operation)
              return (
                <div key={spec.operation} className="flex items-start gap-3">
                  <Button
                    size="sm"
                    variant={spec.destructive ? "destructive" : "outline"}
                    className="w-32 shrink-0 justify-start"
                    disabled={!allowed || busy !== null}
                    data-testid={`sandbox-action-${spec.operation}`}
                    title={
                      allowed
                        ? t(spec.labelKey)
                        : desktop
                          ? t("unsupportedAction")
                          : t("desktopOnly")
                    }
                    onClick={() => void run(spec)}
                  >
                    <spec.icon className="mr-2 size-4" />
                    {t(spec.labelKey)}
                  </Button>
                  <p className="min-w-0 pt-1.5 text-xs text-muted-foreground">
                    {spec.helpKey
                      ? t(spec.helpKey)
                      : allowed
                        ? ""
                        : desktop
                          ? t("unsupportedAction")
                          : t("desktopOnly")}
                  </p>
                </div>
              )
            })}
          </div>
        </section>

        {docker ? <ContainerPolicy config={docker} /> : null}

        {connection.lastHealthError ? (
          <section className="space-y-1">
            <h3 className="text-sm font-medium">{t("statusError")}</h3>
            <p className="break-words text-xs text-destructive">{connection.lastHealthError}</p>
          </section>
        ) : null}
      </div>
    </ResponsiveDetailSheet>
  )
}

function ContainerPolicy({ config }: { config: DockerSandboxConfig }) {
  const t = useTranslations("automation.sandboxConnections")
  return (
    <section className="space-y-2" data-testid="sandbox-container-policy">
      <h3 className="text-sm font-medium">{t("policyTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("policyFrozen")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <PolicyRow
          label={t("policyNetwork")}
          value={
            config.networkMode === "none" ? (
              <Badge variant="default">{t("policyNetworkNone")}</Badge>
            ) : (
              <span className="text-muted-foreground">{t("policyNetworkDefault")}</span>
            )
          }
        />
        <PolicyRow label={t("policyCpus")} value={config.cpus ?? t("policyUnset")} />
        <PolicyRow
          label={t("policyMemory")}
          value={config.memoryMb ? `${config.memoryMb} MiB` : t("policyUnset")}
        />
        <PolicyRow
          label={t("policyWorkspace")}
          value={
            config.workspaceMount
              ? `${config.workspaceMount.hostPath} → ${config.workspaceMount.containerPath}`
              : t("policyNoMount")
          }
        />
        {config.containerId ? (
          <PolicyRow label={t("containerId")} value={config.containerId.slice(0, 12)} />
        ) : null}
      </dl>
    </section>
  )
}

function PolicyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-mono">{value}</dd>
    </>
  )
}
