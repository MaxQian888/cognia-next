"use client"

/**
 * Connectivity → Remote hosts: the registry of Hosts this device drives, and
 * the shared pair step for adding one.
 *
 * The registry rows carry the three actions a row needs (drive, rename,
 * remove). Everything richer about a host (its capability matrix, its
 * workspaces, live presence) is in `/devices`, which the link at the bottom
 * opens on the active host.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, PencilIcon, PlugIcon, Trash2Icon } from "lucide-react"

import { AddHostForm } from "@/components/connectivity/pair/add-host-form"
import { DeviceConsoleLink } from "@/components/devices/device-console-link"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import type { RemoteHostInput } from "@/lib/devices/types"
import { cn } from "@/lib/utils"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

export function RemoteHostsPanel() {
  const t = useTranslations("settings.connectivity.remoteHosts")
  const hosts = useRemoteHostStore((s) => s.hosts)
  const activeHostId = useRemoteHostStore((s) => s.activeHostId)
  const active = hosts.find((host) => host.id === activeHostId)

  return (
    <SettingsStack>
      <SettingsBlock
        title={t("registryTitle")}
        description={t("registryDescription")}
        badge={
          <Badge variant="secondary" data-testid="remote-hosts-count">
            {t("count", { count: hosts.length })}
          </Badge>
        }
        testid="remote-hosts-registry"
      >
        {hosts.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="remote-hosts-empty">
            {t("empty")}
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {hosts.map((host) => (
              <HostRow key={host.id} host={host} active={host.id === activeHostId} />
            ))}
          </ul>
        )}
      </SettingsBlock>

      <SettingsBlock
        title={t("addTitle")}
        description={t("addDescription")}
        testid="remote-hosts-add"
        collapsible
        defaultOpen={hosts.length === 0}
      >
        <AddHostForm />
      </SettingsBlock>

      <DeviceConsoleLink
        surface="hosts"
        count={hosts.length}
        deviceRef={active ? remoteHostRef(active as unknown as RemoteHostInput) : undefined}
      />
    </SettingsStack>
  )
}

function HostRow({ host, active }: { host: RemoteHost; active: boolean }) {
  const t = useTranslations("settings.connectivity.remoteHosts")
  const activateHost = useRemoteHostStore((s) => s.activateHost)
  const removeHost = useRemoteHostStore((s) => s.removeHost)
  const updateHostLabel = useRemoteHostStore((s) => s.updateHostLabel)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(host.label)

  const commitLabel = () => {
    const next = draft.trim()
    if (next && next !== host.label) updateHostLabel(host.id, next)
    setEditing(false)
  }

  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
      data-testid={`remote-host-row-${host.id}`}
      data-active={active}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              commitLabel()
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t("renameAria", { label: host.label })}
              className="h-7 text-xs"
              autoFocus
            />
            <Button type="submit" size="icon-sm" variant="ghost" aria-label={t("renameSave")}>
              <CheckIcon className="size-3.5" aria-hidden="true" />
            </Button>
          </form>
        ) : (
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{host.label}</span>
            {active ? (
              <Badge variant="default" className="text-[10px]" data-testid="remote-host-active">
                {t("active")}
              </Badge>
            ) : null}
            <span
              className={cn(
                "text-[10px] uppercase",
                host.connectionState === "ready"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : host.connectionState === "degraded" || host.connectionState === "connecting"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
              )}
            >
              {t(`state.${host.connectionState}`)}
            </span>
          </p>
        )}
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {host.config.baseUrl}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!active ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => activateHost(host.id)}
            data-testid={`remote-host-drive-${host.id}`}
          >
            <PlugIcon className="mr-1 size-3.5" aria-hidden="true" />
            {t("drive")}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("renameAria", { label: host.label })}
          onClick={() => {
            setDraft(host.label)
            setEditing((prev) => !prev)
          }}
        >
          <PencilIcon className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("removeAria", { label: host.label })}
          onClick={() => removeHost(host.id)}
          data-testid={`remote-host-remove-${host.id}`}
        >
          <Trash2Icon className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}
