"use client"

/**
 * Connectivity → Remote hosts: the registry of Hosts this device drives, and
 * the shared pair step for adding one.
 *
 * Each row carries the actions a registry row needs: connect (or, on the
 * active row, disconnect back to this machine), rename and remove. Everything
 * richer about a host (its capability matrix, its workspaces, live presence)
 * is in `/devices`, which the link at the bottom opens on the active host.
 *
 * The verbs are the device console's, not this panel's own. It used to say
 * "Drive" while `/devices` said Connect / Disconnect and the status-bar
 * switcher said Switch, three words for one act. Connect and disconnect go
 * through `useExecutionHostSwitch` like every other host switch, so a click
 * here cannot repoint the transport under a running turn without asking, and
 * remove always confirms (it forgets the stored credential, and removing the
 * active host also returns this window to local).
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  CheckIcon,
  PencilIcon,
  PlugIcon,
  PlugZapIcon,
  Trash2Icon,
} from "lucide-react"

import { AddHostForm, useScanAvailable } from "@/components/connectivity/pair/add-host-form"
import { GitHubRunnerPanel } from "@/components/settings/connectivity/github-runner-panel"
import { DeviceConsoleLink } from "@/components/devices/device-console-link"
import { hostTone } from "@/components/devices/execution-host-switcher"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { SITE_TONE_DOT, SITE_TONE_TEXT } from "@/components/sites/site-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  useExecutionHostSwitch,
  type ExecutionHostSwitch,
} from "@/hooks/devices/use-execution-host-switch"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import type { RemoteHostInput } from "@/lib/devices/types"
import { cn } from "@/lib/utils"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

export function RemoteHostsPanel() {
  const t = useTranslations("settings.connectivity.remoteHosts")
  const hosts = useRemoteHostStore((s) => s.hosts)
  const activeHostId = useRemoteHostStore((s) => s.activeHostId)
  const active = hosts.find((host) => host.id === activeHostId)
  // One guard (and one dialog) for the whole list rather than one per row.
  const hostSwitch = useExecutionHostSwitch()
  // The pair step only offers its camera scan where the scanner exists (the
  // native mobile shell), so the description only promises scanning there.
  const scanAvailable = useScanAvailable()

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
              <HostRow
                key={host.id}
                host={host}
                active={host.id === activeHostId}
                hostSwitch={hostSwitch}
              />
            ))}
          </ul>
        )}
      </SettingsBlock>

      <SettingsBlock
        title={t("addTitle")}
        description={scanAvailable ? t("addDescriptionScan") : t("addDescription")}
        testid="remote-hosts-add"
        collapsible
        defaultOpen={hosts.length === 0}
      >
        <AddHostForm />
      </SettingsBlock>

      <GitHubRunnerPanel />

      <DeviceConsoleLink
        surface="hosts"
        count={hosts.length}
        deviceRef={active ? remoteHostRef(active as unknown as RemoteHostInput) : undefined}
      />
      {hostSwitch.dialog}
    </SettingsStack>
  )
}

function HostRow({
  host,
  active,
  hostSwitch,
}: {
  host: RemoteHost
  active: boolean
  hostSwitch: Pick<ExecutionHostSwitch, "requestSwitch" | "requestRemove">
}) {
  const t = useTranslations("settings.connectivity.remoteHosts")
  const updateHostLabel = useRemoteHostStore((s) => s.updateHostLabel)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(host.label)
  /**
   * Set by Escape so the blur that follows the field unmounting does not
   * commit the draft the user just abandoned. Written only from handlers.
   */
  const cancelledRef = useRef(false)
  const tone = hostTone(host)

  const startEditing = () => {
    cancelledRef.current = false
    setDraft(host.label)
    setEditing(true)
  }

  const commitLabel = () => {
    if (cancelledRef.current) return
    const next = draft.trim()
    if (next && next !== host.label) updateHostLabel(host.id, next)
    setEditing(false)
  }

  const cancelEditing = () => {
    cancelledRef.current = true
    setDraft(host.label)
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
            {/* Blur commits and Escape cancels, the rename contract the
                device masthead already keeps, so leaving the field by Tab or
                a click elsewhere does not silently throw the edit away. */}
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelEditing()
                }
              }}
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
            {/* The switcher's tone map, so this dot and the status bar's can
                never disagree about what a state looks like. */}
            <span
              className={cn("inline-flex items-center gap-1 text-[10px]", SITE_TONE_TEXT[tone])}
              data-testid={`remote-host-state-${host.id}`}
              data-state={host.connectionState}
            >
              <span
                aria-hidden
                className={cn("inline-block size-1.5 rounded-full", SITE_TONE_DOT[tone])}
              />
              {t(`state.${host.connectionState}`)}
            </span>
          </p>
        )}
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {host.config.baseUrl}
        </p>
        {host.connectionError ? (
          // Verbatim, because it is the only text that names what failed
          // (a refused certificate, a revoked key, an older build), and the
          // state label above only says which kind of failure it was.
          <p
            className="flex items-start gap-1 break-words text-[11px] text-destructive"
            role="status"
            data-testid={`remote-host-error-${host.id}`}
          >
            <AlertCircleIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{host.connectionError}</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {active ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void hostSwitch.requestSwitch(null)}
            data-testid={`remote-host-disconnect-${host.id}`}
          >
            <PlugIcon className="mr-1 size-3.5" aria-hidden="true" />
            {t("disconnect")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void hostSwitch.requestSwitch(host.id)}
            data-testid={`remote-host-connect-${host.id}`}
          >
            <PlugZapIcon className="mr-1 size-3.5" aria-hidden="true" />
            {t("connect")}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("renameAria", { label: host.label })}
          // While editing, the pencil is the cancel toggle. Keeping focus in
          // the field on mousedown stops its blur from committing the draft
          // the click is about to throw away.
          onMouseDown={(event) => {
            if (editing) event.preventDefault()
          }}
          onClick={() => (editing ? cancelEditing() : startEditing())}
        >
          <PencilIcon className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("removeAria", { label: host.label })}
          onClick={() => void hostSwitch.requestRemove(host.id)}
          data-testid={`remote-host-remove-${host.id}`}
        >
          <Trash2Icon className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}
