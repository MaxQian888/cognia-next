"use client"

/**
 * Settings → Remote hosts → Hosts (ADR-0082, R0).
 *
 * Lists paired remote hosts and switches which one the desktop is driving.
 * Connecting installs the host's transport + terminal endpoint (via the store);
 * disconnecting returns to local. Shows the honest capability boundary: reads
 * work with pairing, writes need the host to grant this device control.
 */

import { useTranslations } from "next-intl"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

export function HostsTab() {
  const t = useTranslations("settings.remoteHosts")
  const hosts = useRemoteHostStore((s) => s.hosts)
  const activeHostId = useRemoteHostStore((s) => s.activeHostId)
  const activateHost = useRemoteHostStore((s) => s.activateHost)
  const deactivate = useRemoteHostStore((s) => s.deactivate)
  const removeHost = useRemoteHostStore((s) => s.removeHost)
  const updateHostLabel = useRemoteHostStore((s) => s.updateHostLabel)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  const activeHost = hosts.find((h) => h.id === activeHostId) ?? null

  function startRename(id: string, current: string) {
    setEditingId(id)
    setDraft(current)
  }

  function commitRename() {
    if (editingId) updateHostLabel(editingId, draft)
    setEditingId(null)
    setDraft("")
  }

  if (hosts.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center">
        <p className="text-sm font-medium">{t("list.emptyTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("list.emptyBody")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {activeHost ? (
        <div className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-3">
          <p className="text-sm font-medium">
            {t("list.activeBanner", { label: activeHost.label })}
          </p>
          <p className="text-xs text-muted-foreground">{t("list.capabilityNote")}</p>
        </div>
      ) : null}

      <ul className="space-y-2">
        {hosts.map((host) => {
          const isActive = host.id === activeHostId
          const isEditing = host.id === editingId
          return (
            <li key={host.id} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={t("list.renameLabel")}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        className="h-8 w-48"
                      />
                      <Button size="sm" variant="secondary" onClick={commitRename}>
                        {t("list.save")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        {t("list.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{host.label}</span>
                      {isActive ? <Badge>{t("list.activeBadge")}</Badge> : null}
                    </div>
                  )}
                  <p className="truncate text-xs text-muted-foreground">{host.config.baseUrl}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("list.serverVersion", { version: host.config.serverVersion })}
                    {" · "}
                    {host.lastActiveAt
                      ? new Date(host.lastActiveAt).toLocaleString()
                      : t("list.neverConnected")}
                  </p>
                  {/* What the host told us it can do, asked on activation.
                      Before this a client had no way to know, so workflow
                      preflight judged a cloud server by the desktop's own
                      baseline and refused work the server could have run. */}
                  {host.capabilities && host.capabilities.length > 0 ? (
                    <div
                      className="mt-1 flex flex-wrap gap-1"
                      data-testid={`remote-host-capabilities-${host.id}`}
                    >
                      {host.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="font-mono text-[10px]">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      {t("list.capabilitiesUnknown")}
                    </p>
                  )}
                </div>

                {!isEditing ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {isActive ? (
                      <Button size="sm" variant="secondary" onClick={deactivate}>
                        {t("list.disconnect")}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => activateHost(host.id)}>
                        {t("list.connect")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => startRename(host.id, host.label)}
                    >
                      {t("list.rename")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("list.removeA11y", { label: host.label })}
                      onClick={() => removeHost(host.id)}
                    >
                      {t("list.remove")}
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
