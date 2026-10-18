"use client"

/**
 * The remote desktop viewer (ADR-0234 Phases 2 and 3): one binding, one Host
 * session.
 *
 * The page asks the Host that owns the target (this desktop's own, or a paired
 * Host named by `?host=`) for a session (view, or control with the lease),
 * hands the stream to the provider's viewer (the loopback URL, a ticketed
 * Companion socket, or an attached `cognia.rfb` channel), and keeps the
 * session alive.
 * Taking control from someone else is an explicit choice; losing it, the
 * server closing, or the network dropping all end the session with a stated
 * reason. The note at the bottom says what the Host cannot govern.
 *
 * A web console binding (Phase 5) opens in the desktop app's console webview
 * instead (`RemoteConsoleView`), and elsewhere, like an external app, from a
 * button that asks the Host where to go: neither has a session.
 */

import {
  ArrowLeftIcon,
  ExpandIcon,
  MaximizeIcon,
  MinimizeIcon,
  PlugIcon,
  ShrinkIcon,
  UnplugIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { canLaunch, useRemoteDesktopLaunch } from "@/hooks/remote-desktop/use-remote-desktop-launch"
import { useRemoteDesktopProviders } from "@/hooks/remote-desktop/use-remote-desktop-providers"
import {
  useRemoteDesktopSession,
  type RemoteDesktopSessionDeps,
} from "@/hooks/remote-desktop/use-remote-desktop-session"
import {
  useRemoteDesktopTargets,
  type RemoteDesktopTargetsDeps,
} from "@/hooks/remote-desktop/use-remote-desktop-targets"
import { remoteDesktopErrorMessage } from "@/lib/remote-desktop/error-messages"
import { RemoteDesktopError, toRemoteDesktopError } from "@/lib/remote-desktop/host-client"
import type { RemoteDesktopViewerStatus } from "@/lib/remote-desktop/provider-registry"
import type {
  RemoteDesktopBinding,
  RemoteDesktopHostRef,
  RemoteDesktopSessionMode,
  RemoteDesktopTarget,
} from "@/lib/remote-desktop/types"
import { parseRemoteDesktopViewerParams } from "@/lib/remote-desktop/viewer-href"
import { isTauri } from "@/lib/tauri"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import { RemoteConsoleView } from "./remote-console-view"
import { RemoteDesktopWebviewViewer } from "./remote-desktop-webview-viewer"

export interface RemoteDesktopViewerPageProps {
  targetsDeps?: RemoteDesktopTargetsDeps
  sessionDeps?: RemoteDesktopSessionDeps
}

function Notice({ message }: { message: string }) {
  const t = useTranslations("remoteDesktop")
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button asChild variant="outline" size="sm">
        <Link href="/devices">
          <ArrowLeftIcon className="size-3.5" />
          {t("viewer.back")}
        </Link>
      </Button>
    </div>
  )
}

/** A binding this client opens outside Cognia: the console in a browser, or the app. */
function LaunchNotice({
  host,
  target,
  binding,
}: {
  host: RemoteDesktopHostRef
  target: RemoteDesktopTarget
  binding: RemoteDesktopBinding
}) {
  const t = useTranslations("remoteDesktop")
  const { open, pending } = useRemoteDesktopLaunch(host)
  const [message, setMessage] = useState<string | null>(null)
  const app = binding.access === "external-app"
  const launch = async () => {
    setMessage(null)
    try {
      const outcome = await open(target, binding)
      if (outcome === "app") setMessage(t("console.appAsked"))
    } catch (caught) {
      const refusal = toRemoteDesktopError(caught)
      const text = remoteDesktopErrorMessage(refusal.code, refusal.detail)
      setMessage(t(`errors.${text.key}`, text.values))
    }
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-medium">{target.name}</p>
      <Badge variant="outline">{t("console.providerManaged")}</Badge>
      <p className="text-muted-foreground max-w-md text-sm">
        {app ? t("console.appBody") : t("console.outsideBody")}
      </p>
      <Button
        size="sm"
        disabled={!canLaunch(binding) || !binding.enabled || pending !== null}
        onClick={() => void launch()}
      >
        {app ? t("console.openApp") : t("console.openConsole")}
      </Button>
      {!canLaunch(binding) ? (
        <p className="text-muted-foreground text-xs">{t("console.needsControl")}</p>
      ) : null}
      {message ? (
        <p className="text-muted-foreground text-xs" role="status">
          {message}
        </p>
      ) : null}
      <Button asChild variant="ghost" size="sm">
        <Link href="/devices">
          <ArrowLeftIcon className="size-3.5" />
          {t("viewer.back")}
        </Link>
      </Button>
    </div>
  )
}

export function RemoteDesktopViewerPage({
  targetsDeps,
  sessionDeps,
}: RemoteDesktopViewerPageProps = {}) {
  const t = useTranslations("remoteDesktop")
  const search = useSearchParams()
  const params = useMemo(() => parseRemoteDesktopViewerParams(search), [search])
  // Only a desktop has a Host of its own; anywhere else a link must name one.
  const reachable = params !== null && (params.host.kind === "remote" || isTauri())
  const host = reachable ? params.host : null
  const remoteHostRef = host?.kind === "remote" ? host.hostRef : null
  const hostLabel = useRemoteHostStore((store) =>
    remoteHostRef
      ? store.hosts.find(
          (entry) => entry.id === remoteHostRef || `companion:${entry.id}` === remoteHostRef
        )?.label
      : undefined
  )
  const providers = useRemoteDesktopProviders()
  const {
    host: listedOn,
    targets,
    loading,
    error: loadError,
  } = useRemoteDesktopTargets(host, targetsDeps)
  const target = params ? targets.find((entry) => entry.id === params.targetId) : undefined
  const binding = target?.bindings.find((entry) => entry.id === params?.bindingId)
  const provider = binding
    ? providers.find((entry) => entry.providerId === binding.providerId)
    : undefined
  const access = binding?.access ?? "bridge"
  // Only a bridged binding has a session; the others open from here.
  const sessionTarget = useMemo(
    () =>
      target && binding && access === "bridge"
        ? { targetId: target.id, bindingId: binding.id }
        : null,
    [access, target, binding]
  )
  const { state, connect, disconnect, markEnded } = useRemoteDesktopSession(
    listedOn,
    sessionTarget,
    sessionDeps
  )
  const [viewerStatus, setViewerStatus] = useState<RemoteDesktopViewerStatus>("connecting")
  const [scaleToFit, setScaleToFit] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const lastMode = useRef<RemoteDesktopSessionMode>(params?.mode ?? "control")
  const started = useRef(false)
  const stage = useRef<HTMLDivElement | null>(null)
  const canView = Boolean(binding?.viewOnly && binding.hasViewCredential)

  const open = useCallback(
    (mode: RemoteDesktopSessionMode, takeover = false) => {
      lastMode.current = mode
      setViewerStatus("connecting")
      void connect(mode, takeover)
    },
    [connect]
  )

  useEffect(() => {
    if (started.current || !sessionTarget || !provider || !params) return
    started.current = true
    open(params.mode)
  }, [open, params, provider, sessionTarget])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  const onStatus = useCallback(
    (status: RemoteDesktopViewerStatus) => {
      setViewerStatus(status)
      if (status === "disconnected") markEnded()
    },
    [markEnded]
  )
  const onError = useCallback(
    (code: string) => markEnded(new RemoteDesktopError(code)),
    [markEnded]
  )

  const errorText = (error: RemoteDesktopError) => {
    const message = remoteDesktopErrorMessage(error.code, error.detail)
    return t(`errors.${message.key}`, message.values)
  }

  if (!params) return <Notice message={t("viewer.missingParams")} />
  if (!reachable) return <Notice message={t("viewer.needsHost")} />
  if (loadError) return <Notice message={errorText(loadError)} />
  if (loading && !target) return <Notice message={t("viewer.opening")} />
  if (!target || !binding) return <Notice message={t("viewer.notFound")} />
  if (!provider) return <Notice message={t("viewer.providerMissing")} />
  const owner = listedOn ?? params.host
  if (access === "web-console" && isTauri()) {
    return (
      <RemoteConsoleView host={owner} target={target} binding={binding} hostLabel={hostLabel} />
    )
  }
  if (access !== "bridge") return <LaunchNotice host={owner} target={target} binding={binding} />
  if (provider.definition.integrationMode !== "embedded") {
    return <Notice message={t("viewer.providerMissing")} />
  }

  const session = state.status === "open" ? state.session : null
  const connection = state.status === "open" ? state.connection : null
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void stage.current?.requestFullscreen()
  }
  const Viewer = provider.definition.viewer

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="remote-desktop-viewer-page">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/devices" aria-label={t("viewer.back")}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <h1 className="truncate text-sm font-medium">{target.name}</h1>
        {remoteHostRef ? (
          <span className="text-muted-foreground truncate text-xs">
            {hostLabel ? t("viewer.hostLabel", { host: hostLabel }) : t("viewer.remoteHost")}
          </span>
        ) : null}
        {session ? (
          <Badge variant={session.mode === "control" ? "default" : "secondary"}>
            {session.mode === "control" ? t("viewer.modeControl") : t("viewer.modeView")}
          </Badge>
        ) : null}
        <span className="text-muted-foreground text-xs" role="status">
          {state.status === "opening"
            ? t("viewer.opening")
            : session
              ? viewerStatus === "connected"
                ? t("viewer.connected")
                : t("viewer.connecting")
              : t("viewer.disconnected")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {session?.mode === "view" ? (
            <Button size="sm" onClick={() => open("control")}>
              {t("viewer.takeControl")}
            </Button>
          ) : null}
          {session?.mode === "control" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => (canView ? open("view") : disconnect())}
            >
              {t("viewer.release")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={scaleToFit}
            onClick={() => setScaleToFit((value) => !value)}
          >
            {scaleToFit ? <ShrinkIcon className="size-4" /> : <ExpandIcon className="size-4" />}
            {scaleToFit ? t("viewer.actualSize") : t("viewer.fit")}
          </Button>
          <Button size="sm" variant="ghost" onClick={toggleFullscreen}>
            {fullscreen ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
            {fullscreen ? t("viewer.exitFullscreen") : t("viewer.fullscreen")}
          </Button>
          {session ? (
            <Button size="sm" variant="ghost" onClick={disconnect}>
              <UnplugIcon className="size-4" />
              {t("viewer.disconnect")}
            </Button>
          ) : state.status === "ended" ? (
            <Button size="sm" variant="ghost" onClick={() => open(lastMode.current)}>
              <PlugIcon className="size-4" />
              {t("viewer.reconnect")}
            </Button>
          ) : null}
        </div>
      </header>

      {state.status === "busy" ? (
        <Alert className="m-3 w-auto">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{t("viewer.takeControlBusy")}</span>
            <Button size="sm" onClick={() => open("control", true)}>
              {t("viewer.takeOver")}
            </Button>
            {canView ? (
              <Button size="sm" variant="outline" onClick={() => open("view")}>
                {t("viewer.viewOnlyInstead")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {state.status === "ended" ? (
        <Alert variant={state.error ? "destructive" : "default"} className="m-3 w-auto">
          <AlertDescription>
            {state.error
              ? state.error.code === "remote_desktop_lease_lost"
                ? t("viewer.lostControl")
                : errorText(state.error)
              : t("viewer.ended")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div ref={stage} className="relative min-h-0 flex-1 bg-black">
        {session && connection ? (
          Viewer.kind === "react" ? (
            <Viewer.component
              key={session.sessionId}
              connection={connection}
              mode={session.mode}
              scaleToFit={scaleToFit}
              onStatus={onStatus}
              onError={onError}
              className="h-full w-full"
            />
          ) : (
            <RemoteDesktopWebviewViewer
              key={session.sessionId}
              pluginId={provider.pluginId}
              viewId={Viewer.viewId}
              title={provider.definition.name}
              connection={connection}
              mode={session.mode}
              scaleToFit={scaleToFit}
              onStatus={onStatus}
              onError={onError}
              className="h-full w-full"
            />
          )
        ) : null}
      </div>

      <footer className="text-muted-foreground border-t px-3 py-1.5 text-xs">
        {session?.mode === "view" ? `${t("viewer.viewOnlyHint")} ` : null}
        {t("viewer.unmanagedNote")}
      </footer>
    </div>
  )
}
