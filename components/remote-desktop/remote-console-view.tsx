"use client"

/**
 * A web console binding in the desktop app (ADR-0234 Phase 5): the user's
 * own Guacamole or MeshCentral page in the native `remote-console` webview,
 * pinned over this component's stage.
 *
 * The Host is asked where to go when the page opens (`binding_launch`, which
 * needs control). The webview follows the stage's box, parks off-screen while
 * the window is hidden or a dialog, menu or toast would sit over it (a native
 * layer always paints on top), and closes when the page goes away. Cognia brokers
 * nothing here: the console signs the user in and decides what they may do,
 * which is what the badge says.
 */

import { ArrowLeftIcon, RotateCwIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { readElementRect, useElementRect } from "@/hooks/browser/use-element-rect"
import { useRegionVisibility } from "@/hooks/browser/use-region-visibility"
import type { ElementRect } from "@/lib/browser/protocol"
import {
  closeConsoleWebview,
  openConsoleWebview,
  reloadConsoleWebview,
  setConsoleWebviewBounds,
  setConsoleWebviewVisible,
} from "@/lib/remote-desktop/console-webview"
import { remoteDesktopErrorMessage } from "@/lib/remote-desktop/error-messages"
import {
  launchRemoteDesktopBinding,
  RemoteDesktopError,
  toRemoteDesktopError,
} from "@/lib/remote-desktop/host-client"
import type {
  RemoteDesktopBinding,
  RemoteDesktopHostRef,
  RemoteDesktopTarget,
} from "@/lib/remote-desktop/types"

export interface RemoteConsoleWebviewApi {
  open: typeof openConsoleWebview
  setBounds: typeof setConsoleWebviewBounds
  setVisible: typeof setConsoleWebviewVisible
  reload: typeof reloadConsoleWebview
  close: typeof closeConsoleWebview
}

const DEFAULT_WEBVIEW: RemoteConsoleWebviewApi = {
  open: openConsoleWebview,
  setBounds: setConsoleWebviewBounds,
  setVisible: setConsoleWebviewVisible,
  reload: reloadConsoleWebview,
  close: closeConsoleWebview,
}

export interface RemoteConsoleViewProps {
  host: RemoteDesktopHostRef
  target: RemoteDesktopTarget
  binding: RemoteDesktopBinding
  /** Where the target lives when it is not this desktop's own Host. */
  hostLabel?: string
  launch?: typeof launchRemoteDesktopBinding
  webview?: RemoteConsoleWebviewApi
}

type State =
  { status: "opening" } | { status: "open" } | { status: "failed"; error: RemoteDesktopError }

export function RemoteConsoleView({
  host,
  target,
  binding,
  hostLabel,
  launch = launchRemoteDesktopBinding,
  webview = DEFAULT_WEBVIEW,
}: RemoteConsoleViewProps) {
  const t = useTranslations("remoteDesktop")
  const router = useRouter()
  const stage = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<State>({ status: "opening" })
  const opened = useRef(false)
  const api = useRef(webview)

  const place = useCallback((rect: ElementRect) => {
    if (!opened.current) return
    void api.current.setBounds(rect).catch(() => undefined)
  }, [])
  useElementRect(stage, place, { trackState: false })
  const visible = useRegionVisibility(stage)

  useEffect(() => {
    const view = api.current
    let cancelled = false
    const start = async () => {
      try {
        const launched = await launch(host, { targetId: target.id, bindingId: binding.id })
        if (cancelled) return
        if (launched.kind !== "web-console") {
          throw new RemoteDesktopError("remote_desktop_binding_access_invalid")
        }
        const element = stage.current
        if (!element) return
        await view.open(launched.url, readElementRect(element))
        if (cancelled) {
          void view.close().catch(() => undefined)
          return
        }
        opened.current = true
        setState({ status: "open" })
      } catch (error) {
        if (!cancelled) setState({ status: "failed", error: toRemoteDesktopError(error) })
      }
    }
    void start()
    return () => {
      cancelled = true
      opened.current = false
      void view.close().catch(() => undefined)
    }
  }, [binding.id, host, launch, target.id])

  useEffect(() => {
    const element = stage.current
    if (state.status !== "open" || !element) return
    void api.current.setVisible(visible, readElementRect(element)).catch(() => undefined)
  }, [state.status, visible])

  const errorText = (error: RemoteDesktopError) => {
    const message = remoteDesktopErrorMessage(error.code, error.detail)
    return t(`errors.${message.key}`, message.values)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="remote-console-view">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/devices" aria-label={t("viewer.back")}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <h1 className="truncate text-sm font-medium">{target.name}</h1>
        {hostLabel ? (
          <span className="text-muted-foreground truncate text-xs">
            {t("viewer.hostLabel", { host: hostLabel })}
          </span>
        ) : null}
        <Badge variant="outline">{t("console.providerManaged")}</Badge>
        {binding.endpoint ? (
          <span className="text-muted-foreground font-mono text-xs">{binding.endpoint.host}</span>
        ) : null}
        <span className="text-muted-foreground text-xs" role="status">
          {state.status === "opening"
            ? t("console.opening")
            : state.status === "open"
              ? t("console.open")
              : t("console.failed")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={state.status !== "open"}
            onClick={() => void api.current.reload().catch(() => undefined)}
          >
            <RotateCwIcon className="size-4" />
            {t("console.reload")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => router.push("/devices")}>
            <XIcon className="size-4" />
            {t("console.close")}
          </Button>
        </div>
      </header>
      {state.status === "failed" ? (
        <Alert variant="destructive" className="m-3 w-auto">
          <AlertDescription>{errorText(state.error)}</AlertDescription>
        </Alert>
      ) : null}
      <div ref={stage} className="bg-muted/30 relative min-h-0 flex-1" />
      <footer className="text-muted-foreground border-t px-3 py-1.5 text-xs">
        {t("console.note")}
      </footer>
    </div>
  )
}
