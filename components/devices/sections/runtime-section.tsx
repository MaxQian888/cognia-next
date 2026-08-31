"use client"

/**
 * What this device can actually run: sandbox tiers, sandbox connections,
 * workspace environments, and how execution is currently directed.
 *
 * Every "not available" here is dictated by the transport routing rules in
 * `lib/tauri/transport-routing.ts`, not by a guess about the device:
 *
 *  * `cua_sandbox_*` are `target: "client"`, so **sandbox connections always
 *    belong to the machine running this renderer**. A remote Host's sandboxes
 *    are its own business and are not reachable from here at all.
 *  * `task_workspace_environment_list` is `target: "execution"`, so it follows
 *    the active remote host. Rendering it under the local device while a Host
 *    is active would print that Host's worktrees under this machine's name.
 *    An inactive Host is therefore not read through global routing at all: it
 *    is probed over its own isolated transport (`useHostProbe`), which is what
 *    `openRemoteHostTarget` was built for and had no UI caller until now.
 *    Activation is still offered, because a probe is a read and everything
 *    that writes needs the routing target.
 *
 * The sandbox registry itself is the existing settings surface, embedded
 * rather than reimplemented, so the two cannot drift.
 *
 * Four cards rather than one: tiers are a short list, the registry is a table,
 * and routing is a pair of controls. Carding them separately is what lets the
 * short ones sit beside each other instead of stacking a screen apart.
 */

import { useCallback, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import {
  BoxIcon,
  FolderTreeIcon,
  GavelIcon,
  LayersIcon,
  PlugZapIcon,
  RadarIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SandboxConnectionsTab } from "@/components/settings/automation/sandbox-connections-tab"
import { WorkspaceEnvironmentList } from "@/components/workspace/workspace-environment-list"
import { useHostProbe } from "@/hooks/devices/use-host-probe"
import {
  getExecutionAuthorityConfigServerSnapshot,
  getExecutionAuthorityConfigSnapshot,
  subscribeExecutionAuthorityConfig,
  writeExecutionAuthorityConfig,
} from "@/lib/placement/authority"
import type { DeviceRow } from "@/lib/devices/types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"

function ShellTiers({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  if (row.runtime.shellTiers.length === 0) return null
  const available = row.runtime.shellTiers.filter((tier) => tier.available).length
  return (
    <DeviceSection
      id="shell-tiers"
      title={t("runtime.shellTiers")}
      icon={LayersIcon}
      meta={t("runtime.tierCount", { available, total: row.runtime.shellTiers.length })}
    >
      <ul className="space-y-2" data-testid="device-shell-tiers">
        {row.runtime.shellTiers.map((tier) => (
          <li
            key={tier.tier}
            className="flex items-baseline gap-2"
            data-testid={`shell-tier-${tier.tier}`}
          >
            <span className="min-w-0 flex-1">
              <span className="font-mono text-[11px]">{tier.tier}</span>
              {tier.reasonKey ? (
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
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
    </DeviceSection>
  )
}

/**
 * Where execution is pointed, and who owns scheduled timing.
 *
 * The two belong together: the first says where a call from this window lands
 * right now, the second says which machine is allowed to arm work nobody is
 * watching. Read apart, each invites the wrong conclusion about the other.
 */
function Routing({ row }: { row: DeviceRow }) {
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
  const canOwnTiming = row.kind === "local" || row.kind === "remote-host"
  if (!canOwnTiming && !row.runtime.isRoutingTarget) return null

  const isAuthority = row.kind === "local" ? config.hostId === null : config.hostId === row.hostId

  return (
    <DeviceSection id="routing" title={t("runtime.routing")} icon={GavelIcon}>
      {row.runtime.isRoutingTarget ? (
        <p
          className="mb-3 rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-400"
          data-testid="routing-target-note"
        >
          {t("runtime.isRoutingTarget")}
        </p>
      ) : null}

      {canOwnTiming ? (
        <div
          className="flex items-start justify-between gap-3"
          data-testid="device-timing-authority"
        >
          <div className="min-w-0">
            <h4 className="text-sm font-medium">{t("runtime.timingAuthority")}</h4>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {t("runtime.timingAuthorityHint")}
            </p>
          </div>
          <Switch
            checked={isAuthority}
            onCheckedChange={(next) =>
              writeExecutionAuthorityConfig({
                ...config,
                // Turning it off returns to self-authority, which is the
                // zero-configuration default: every host arms its own
                // schedules and the deterministic idempotency key absorbs
                // the duplicate.
                hostId: next ? (row.kind === "local" ? null : (row.hostId ?? null)) : null,
              })
            }
            aria-label={t("runtime.timingAuthorityAria", { label: row.label })}
            data-testid="timing-authority-switch"
          />
        </div>
      ) : null}
    </DeviceSection>
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

  const supported = row.runtime.workspaces.support === "supported"
  const inactiveHost = row.runtime.workspaces.support === "requires-activation"

  // Only a remote Host can be read over its own transport. `requires-activation`
  // on the LOCAL row means a Host is active and routing points away from here,
  // and there is no second transport that reaches back to this machine.
  const probeRef = inactiveHost && row.kind === "remote-host" ? (row.hostId ?? null) : null
  const { state: probe, probe: runProbe } = useHostProbe(probeRef)

  return (
    <DeviceSection id="workspaces" title={t("runtime.workspaces")} icon={FolderTreeIcon} wide>
      <div data-testid="device-workspaces">
        {supported ? (
          <WorkspaceEnvironmentList presentation="sheet" showPrune />
        ) : (
          <Alert>
            <AlertTitle>
              {inactiveHost
                ? t("runtime.workspacesInactiveTitle")
                : t("runtime.workspacesUnsupportedTitle")}
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <span className="block">
                {t(`runtime.reason.${row.runtime.workspaces.reasonKey ?? "workspaceNotHosted"}`)}
              </span>
              {inactiveHost ? (
                <span className="flex flex-wrap gap-2">
                  {/* Reading is the common case, so it leads. Activation is
                      still offered beside it because everything that WRITES
                      needs this host to be the routing target. */}
                  {probeRef ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={runProbe}
                      disabled={probe.status === "probing"}
                      data-testid="probe-host-workspaces"
                    >
                      <RadarIcon className="size-3.5" />
                      {probe.status === "probing"
                        ? t("runtime.probing")
                        : t("runtime.probeWorkspaces")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant={probeRef ? "ghost" : "outline"}
                    onClick={activate}
                    data-testid="activate-routing-target"
                  >
                    <PlugZapIcon className="size-3.5" />
                    {row.kind === "local" ? t("runtime.routeLocally") : t("runtime.activateHost")}
                  </Button>
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        )}

        <HostProbeResult probe={probe} />
      </div>
    </DeviceSection>
  )
}

/**
 * What the isolated probe found, labelled with where it came from.
 *
 * Saying "read over this host's own connection" is not decoration: these rows
 * did not come through the transport every other number on this page came
 * through, and a reader who assumes otherwise will misread an empty list as
 * "the active host has no worktrees".
 */
function HostProbeResult({ probe }: { probe: ReturnType<typeof useHostProbe>["state"] }) {
  const t = useTranslations("devices")
  if (probe.status === "idle" || probe.status === "probing") return null

  if (probe.status === "error") {
    return (
      <p className="mt-2 text-xs text-destructive" data-testid="host-probe-error">
        {t("runtime.probeFailed", { error: probe.message })}
      </p>
    )
  }

  return (
    <div className="mt-3 space-y-1.5" data-testid="host-probe-result">
      <p className="text-[11px] text-muted-foreground">
        {t("runtime.probedVia", { count: probe.environments.length })}
      </p>
      {probe.environments.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("runtime.probeEmpty")}</p>
      ) : (
        <ul className="space-y-1">
          {probe.environments.map((env) => (
            <li
              key={env.environmentId}
              className="flex items-baseline gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{env.path}</span>
              {env.branch ? (
                <span className="shrink-0 text-muted-foreground">{env.branch}</span>
              ) : null}
              {env.locked ? (
                <Badge variant="outline" className="shrink-0 font-normal">
                  {t("runtime.probeLocked")}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function RuntimeSection({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const sandboxSupported = row.runtime.sandbox.support === "supported"

  return (
    <>
      <ShellTiers row={row} />
      <Routing row={row} />

      {/* The registry is already a titled Card of its own, so it *is* the
          section here rather than sitting inside a second one — nesting them
          would give the reader two headers and two borders for one thing.
          Only the explanation we write ourselves needs a frame from us. */}
      {sandboxSupported ? (
        <div className="min-w-0 @3xl/device-pane:col-span-2" data-testid="device-sandbox">
          <SandboxConnectionsTab />
        </div>
      ) : (
        <DeviceSection id="sandbox" title={t("runtime.sandbox")} icon={BoxIcon}>
          <div data-testid="device-sandbox">
            <Alert>
              <AlertTitle>{t("runtime.sandboxUnsupportedTitle")}</AlertTitle>
              <AlertDescription>
                {t(`runtime.reason.${row.runtime.sandbox.reasonKey ?? "sandboxNotHosted"}`)}
              </AlertDescription>
            </Alert>
          </div>
        </DeviceSection>
      )}

      <Workspaces row={row} />
    </>
  )
}
