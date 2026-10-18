"use client"

/**
 * Remote desktops (ADR-0234 Phases 2 and 3): a Host's chapter listing other
 * machines' screens it opens through its own bridge. On the local desktop
 * that Host is this machine; on a Host row (a store Host, or the `/pair` Host
 * a phone or browser is connected to) it is that Host, over its management
 * channel.
 *
 *  * **Host-owned.** Targets, pinned endpoints and passwords live on the
 *    Host. A password is entered here, sent to the Host once and never shown
 *    again.
 *  * **Confirmed endpoints.** Each address is resolved once, pinned, and
 *    confirmed as LAN or plaintext internet before anything connects to it.
 *  * **Honest about read-only.** View-only is offered only where the server
 *    enforces its own view password; everything else says it can only be
 *    opened with full control.
 *  * **Honest about governance.** Only sessions opened here share one
 *    controller and are audited; the note says a direct VNC client bypasses it.
 *    Web consoles and RustDesk (Phase 5) are labelled as managed by their
 *    provider: Cognia opens them and audits the open, nothing more.
 */

import {
  ExternalLinkIcon,
  MonitorIcon,
  MonitorPlayIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  canLaunch,
  isLaunchable,
  useRemoteDesktopLaunch,
  type RemoteDesktopLaunchDeps,
} from "@/hooks/remote-desktop/use-remote-desktop-launch"
import { useRemoteDesktopProviders } from "@/hooks/remote-desktop/use-remote-desktop-providers"
import {
  useRemoteDesktopTargets,
  type RemoteDesktopTargetsDeps,
} from "@/hooks/remote-desktop/use-remote-desktop-targets"
import { remoteDesktopErrorMessage } from "@/lib/remote-desktop/error-messages"
import { toRemoteDesktopError } from "@/lib/remote-desktop/host-client"
import { remoteDesktopViewerHref } from "@/lib/remote-desktop/viewer-href"
import type {
  RemoteDesktopBinding,
  RemoteDesktopHostRef,
  RemoteDesktopSessionMode,
  RemoteDesktopTarget,
} from "@/lib/remote-desktop/types"

import { DeviceSection } from "../device-section"
import { RemoteDesktopTargetDialog, type DialogState } from "./remote-desktop-target-dialog"

export interface RemoteDesktopSectionProps {
  /** The Host whose targets these are. */
  host: RemoteDesktopHostRef
  /** A remote Host's name, for the copy that says where things live. */
  hostLabel?: string
  deps?: RemoteDesktopTargetsDeps
  launchDeps?: RemoteDesktopLaunchDeps
}

export function RemoteDesktopSection({
  host,
  hostLabel,
  deps,
  launchDeps,
}: RemoteDesktopSectionProps) {
  const t = useTranslations("remoteDesktop")
  const tDevices = useTranslations("devices")
  const router = useRouter()
  const providers = useRemoteDesktopProviders()
  const { targets, loading, error, reload, saveTarget, deleteTarget } = useRemoteDesktopTargets(
    host,
    deps
  )
  const remote = host.kind === "remote"
  const hostName = hostLabel ?? ""
  const outdated = error?.code === "remote_desktop_host_outdated"
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [deleting, setDeleting] = useState<RemoteDesktopTarget | null>(null)
  const launcher = useRemoteDesktopLaunch(host, launchDeps)

  const errorText = (caught: unknown) => {
    const refusal = toRemoteDesktopError(caught)
    const message = remoteDesktopErrorMessage(refusal.code, refusal.detail)
    return t(`errors.${message.key}`, message.values)
  }

  const open = (
    target: RemoteDesktopTarget,
    binding: RemoteDesktopBinding,
    mode: RemoteDesktopSessionMode
  ) =>
    router.push(remoteDesktopViewerHref({ host, targetId: target.id, bindingId: binding.id, mode }))

  const launch = async (target: RemoteDesktopTarget, binding: RemoteDesktopBinding) => {
    try {
      const outcome = await launcher.open(target, binding)
      // Cognia never learns whether RustDesk connected.
      if (outcome === "app") toast.success(t("console.appAsked"))
    } catch (caught) {
      toast.error(errorText(caught))
    }
  }

  const confirmDelete = async () => {
    const target = deleting
    if (!target) return
    setDeleting(null)
    try {
      await deleteTarget(target.id)
      toast.success(t("section.deleted"))
    } catch (caught) {
      toast.error(errorText(caught))
    }
  }

  return (
    <DeviceSection
      id="remote-desktop"
      title={tDevices("remoteDesktop.title")}
      icon={MonitorIcon}
      description={
        remote ? t("section.descriptionRemote", { host: hostName }) : t("section.description")
      }
      meta={targets.length > 0 ? String(targets.length) : undefined}
      wide
    >
      <div className="flex flex-col gap-3">
        {outdated ? (
          <Alert>
            <AlertDescription>{t("section.hostOutdated", { host: hostName })}</AlertDescription>
          </Alert>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("section.loadFailed")}</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>{errorText(error)}</span>
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                {t("section.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {!loading && !error && targets.length === 0 ? (
          <Empty className="border border-dashed py-6">
            <EmptyHeader>
              <EmptyTitle>{t("section.emptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {remote ? t("section.emptyBodyRemote", { host: hostName }) : t("section.emptyBody")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        <ul className="flex flex-col divide-y" aria-busy={loading}>
          {targets.map((target) => (
            <li
              key={target.id}
              className="flex flex-col gap-2 py-2.5"
              data-testid={`remote-desktop-target-${target.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{target.name}</span>
                <div
                  className="flex shrink-0 items-center gap-1"
                  role="group"
                  aria-label={t("section.actionsLabel", { name: target.name })}
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDialog({ kind: "edit", target, bindingId: target.bindings[0]?.id })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                    {t("section.edit")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(target)}>
                    <Trash2Icon className="size-3.5" />
                    {t("section.delete")}
                  </Button>
                </div>
              </div>
              {target.bindings.map((binding) => {
                const provider = providers.find((entry) => entry.providerId === binding.providerId)
                const providerName = provider
                  ? provider.definition.name
                  : t("section.providerMissing")
                if (isLaunchable(binding)) {
                  const app = binding.access === "external-app"
                  const allowed = canLaunch(binding)
                  return (
                    <div key={binding.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">{providerName}</span>
                      {app ? (
                        binding.launch?.peerId ? (
                          <span className="font-mono text-xs">
                            {binding.launch.server
                              ? t("section.peerOnServer", {
                                  peer: binding.launch.peerId,
                                  server: binding.launch.server,
                                })
                              : binding.launch.peerId}
                          </span>
                        ) : null
                      ) : binding.endpoint ? (
                        <>
                          <span className="font-mono text-xs">{binding.endpoint.host}</span>
                          <Badge
                            variant={binding.endpoint.class === "public" ? "outline" : "secondary"}
                          >
                            {binding.endpoint.class === "public"
                              ? t("section.classInternet")
                              : t("section.classPrivate")}
                          </Badge>
                        </>
                      ) : null}
                      <Badge variant="outline">{t("console.providerManaged")}</Badge>
                      {!binding.enabled ? (
                        <Badge variant="outline">{t("section.disabled")}</Badge>
                      ) : null}
                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          size="sm"
                          disabled={
                            !provider ||
                            !binding.enabled ||
                            !allowed ||
                            launcher.pending === binding.id
                          }
                          title={allowed ? undefined : t("console.needsControl")}
                          onClick={() => void launch(target, binding)}
                        >
                          <ExternalLinkIcon className="size-3.5" />
                          {app ? t("console.openApp") : t("console.openConsole")}
                        </Button>
                      </div>
                    </div>
                  )
                }
                const canView = binding.viewOnly && binding.hasViewCredential
                const endpoint = binding.endpoint
                return (
                  <div key={binding.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{providerName}</span>
                    {endpoint ? (
                      <>
                        <span
                          className="font-mono text-xs"
                          title={t("section.pinned", { ip: endpoint.pinnedIp })}
                        >
                          {t("section.endpoint", { host: endpoint.host, port: endpoint.port })}
                        </span>
                        <Badge variant={endpoint.class === "public" ? "destructive" : "secondary"}>
                          {endpoint.class === "public"
                            ? t("section.classPublic")
                            : t("section.classPrivate")}
                        </Badge>
                      </>
                    ) : null}
                    <Badge variant="outline">
                      {binding.viewOnly ? t("section.viewOnly") : t("section.noViewOnly")}
                    </Badge>
                    {binding.adapter === "vnc" ? (
                      <Badge variant="outline">
                        {binding.hasControlCredential
                          ? t("section.passwordSet")
                          : t("section.noPassword")}
                      </Badge>
                    ) : null}
                    {!binding.enabled ? (
                      <Badge variant="outline">{t("section.disabled")}</Badge>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1">
                      {canView ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!provider || !binding.enabled}
                          onClick={() => open(target, binding, "view")}
                        >
                          {t("section.openViewOnly")}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        disabled={!provider || !binding.enabled}
                        onClick={() => open(target, binding, "control")}
                      >
                        <MonitorPlayIcon className="size-3.5" />
                        {t("section.open")}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">{t("section.unmanagedNote")}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={outdated}
            onClick={() => setDialog({ kind: "add" })}
          >
            <PlusIcon className="size-3.5" />
            {t("section.add")}
          </Button>
        </div>
      </div>

      {dialog ? (
        <RemoteDesktopTargetDialog
          state={dialog}
          host={host}
          hostLabel={hostLabel}
          providers={providers}
          onClose={() => setDialog(null)}
          onSave={saveTarget}
        />
      ) : null}

      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("section.deleteTitle", { name: deleting?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {remote ? t("section.deleteBodyRemote", { host: hostName }) : t("section.deleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("section.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("section.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DeviceSection>
  )
}
