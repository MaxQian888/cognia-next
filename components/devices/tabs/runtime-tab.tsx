"use client"

/**
 * What this device can actually run: sandbox tiers, sandbox connections,
 * workspace environments, and whether it owns scheduled timing.
 *
 * Every "not available" here is dictated by the transport routing rules in
 * `lib/tauri/transport-routing.ts`, not by a guess about the device:
 *
 *  * `cua_sandbox_*` are `target: "client"`, so **sandbox connections always
 *    belong to the machine running this renderer**. A remote Host's sandboxes
 *    are its own business and are not reachable from here at all.
 *  * `task_workspace_environment_list` is `target: "execution"`, so it follows
 *    the active remote host. Rendering it under the local device while a Host
 *    is active would print that Host's worktrees under this machine's name —
 *    which is why an inactive Host offers an Activate button instead of a
 *    list.
 *
 * The sandbox registry itself is the existing settings surface, embedded
 * rather than reimplemented, so the two cannot drift.
 */

import { useCallback, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { GavelIcon, PlugZapIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SandboxConnectionsTab } from "@/components/settings/automation/sandbox-connections-tab"
import { WorkspaceEnvironmentList } from "@/components/workspace/workspace-environment-list"
import {
  getExecutionAuthorityConfigServerSnapshot,
  getExecutionAuthorityConfigSnapshot,
  subscribeExecutionAuthorityConfig,
  writeExecutionAuthorityConfig,
} from "@/lib/placement/authority"
import type { DeviceRow } from "@/lib/devices/types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { cn } from "@/lib/utils"

function ShellTiers({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  if (row.runtime.shellTiers.length === 0) return null
  return (
    <section data-testid="device-shell-tiers">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("runtime.shellTiers")}
      </h3>
      <ul className="divide-y divide-border/50">
        {row.runtime.shellTiers.map((tier) => (
          <li
            key={tier.tier}
            className="flex items-baseline gap-2 py-1.5"
            data-testid={`shell-tier-${tier.tier}`}
          >
            <span className="min-w-0 flex-1">
              <span className="font-mono text-[11px]">{tier.tier}</span>
              {tier.reasonKey ? (
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {t(`runtime.tierReason.${tier.reasonKey}`)}
                </span>
              ) : null}
            </span>
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 font-normal",
                tier.available ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
              )}
            >
              {tier.available ? t("runtime.tierAvailable") : t("runtime.tierUnavailable")}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TimingAuthority({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  // localStorage is unreadable during the server render, so the server
  // snapshot is the default rather than a read that would mismatch on hydrate.
  const config = useSyncExternalStore(
    subscribeExecutionAuthorityConfig,
    getExecutionAuthorityConfigSnapshot,
    getExecutionAuthorityConfigServerSnapshot
  )

  // `ExecutionAuthorityConfig.hostId` is a `RemoteHost.id`, or null for self.
  // A phone or a worker cannot be named, so the control is only offered where
  // it can actually be honoured.
  if (row.kind !== "local" && row.kind !== "remote-host") return null

  const isAuthority = row.kind === "local" ? config.hostId === null : config.hostId === row.hostId

  return (
    <section className="rounded-md border p-3" data-testid="device-timing-authority">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <GavelIcon className="size-3.5 text-muted-foreground" />
            {t("runtime.timingAuthority")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("runtime.timingAuthorityHint")}</p>
        </div>
        <Switch
          checked={isAuthority}
          onCheckedChange={(next) =>
            writeExecutionAuthorityConfig({
              ...config,
              // Turning it off returns to self-authority, which is the
              // zero-configuration default: every host arms its own schedules
              // and the deterministic idempotency key absorbs the duplicate.
              hostId: next ? (row.kind === "local" ? null : (row.hostId ?? null)) : null,
            })
          }
          aria-label={t("runtime.timingAuthorityAria", { label: row.label })}
          data-testid="timing-authority-switch"
        />
      </div>
    </section>
  )
}

function Workspaces({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const activateHost = useRemoteHostStore((state) => state.activateHost)
  const deactivate = useRemoteHostStore((state) => state.deactivate)

  const activate = useCallback(() => {
    if (row.kind === "local") deactivate()
    else if (row.hostId) activateHost(row.hostId)
  }, [activateHost, deactivate, row.hostId, row.kind])

  if (row.runtime.workspaces.support === "supported") {
    return (
      <section data-testid="device-workspaces">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("runtime.workspaces")}
        </h3>
        <WorkspaceEnvironmentList presentation="page" showPrune />
      </section>
    )
  }

  return (
    <section data-testid="device-workspaces">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("runtime.workspaces")}
      </h3>
      <Alert>
        <AlertTitle>
          {row.runtime.workspaces.support === "requires-activation"
            ? t("runtime.workspacesInactiveTitle")
            : t("runtime.workspacesUnsupportedTitle")}
        </AlertTitle>
        <AlertDescription className="space-y-2">
          <span className="block">
            {t(`runtime.reason.${row.runtime.workspaces.reasonKey ?? "workspaceNotHosted"}`)}
          </span>
          {row.runtime.workspaces.support === "requires-activation" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={activate}
              data-testid="activate-routing-target"
            >
              <PlugZapIcon className="size-3.5" />
              {row.kind === "local" ? t("runtime.routeLocally") : t("runtime.activateHost")}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    </section>
  )
}

export function RuntimeTab({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")

  return (
    <div className="space-y-4" data-testid="device-runtime-tab">
      {row.runtime.isRoutingTarget ? (
        <p className="text-[11px] text-muted-foreground" data-testid="routing-target-note">
          {t("runtime.isRoutingTarget")}
        </p>
      ) : null}

      <ShellTiers row={row} />

      <section data-testid="device-sandbox">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("runtime.sandbox")}
        </h3>
        {row.runtime.sandbox.support === "supported" ? (
          <SandboxConnectionsTab />
        ) : (
          <Alert>
            <AlertTitle>{t("runtime.sandboxUnsupportedTitle")}</AlertTitle>
            <AlertDescription>
              {t(`runtime.reason.${row.runtime.sandbox.reasonKey ?? "sandboxNotHosted"}`)}
            </AlertDescription>
          </Alert>
        )}
      </section>

      <Workspaces row={row} />
      <TimingAuthority row={row} />
    </div>
  )
}
