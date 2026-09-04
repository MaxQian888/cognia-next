"use client"

// What a companion can do about the Pro IDE on the host it is driving.
//
// The sibling `pro-ide-section.tsx` owns the LOCAL install: the pinned version,
// the on-disk footprint, the pre-fetch. Every one of its commands is
// `target: "client"`, so on a phone or a browser it has nothing to manage and
// says so. That left a paired client with no Pro IDE surface at all, even
// though `codeserver_ensure` / `status` / `stop` have been reachable over the
// wire the whole time and nothing on screen called them.
//
// This card is the other half: start and stop the host's workbench, see which
// workspace it is bound to, and read plainly where it can actually be opened.
// The last part is the honest one. A remote workbench is served on a loopback
// port on the HOST behind a device-authenticated relay, and an iframe cannot
// attach an Authorization header, so a phone and an off-machine browser can
// control the workbench without being able to render it.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { PlayIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { CodeServerWebFrame } from "@/components/editor/project/code-server-web-frame"
import { SurfaceUnavailableNotice } from "@/components/platform/surface-unavailable-notice"
import { useSurfaceReach } from "@/hooks/platform/use-surface-reach"
import { codeServerClient, type CodeServerStatus } from "@/lib/codeserver/client"
import { defaultCompanionEndpointResolver } from "@/lib/tauri/companion-endpoint"
import { primaryRootOf } from "@/lib/workspace/roots"
import { activeHostSupportsFeature } from "@/stores/remote-host/remote-host-store"
import { useProjectStore } from "@/stores/project/project-store"

type Busy = "start" | "stop" | null

export function ProIdeHostCard() {
  const t = useTranslations("settings.proIde.host")
  /**
   * `hostProvides` rather than the static server-backed list: `pro-ide` is not
   * in it, and cannot be, because whether a host runs a workbench is a property
   * of that host's build rather than of the companion profile. The feature
   * manifest is the only thing that knows, which is why ADR-0088's five
   * lifecycle commands were undiscoverable until `pro-ide` was declared.
   */
  const hostProvides = activeHostSupportsFeature("pro-ide", "codeserver_ensure")
  const reach = useSurfaceReach({ capability: "pro-ide", hostProvides })

  const project = useProjectStore((state) =>
    state.activeProjectId
      ? (state.projects.find((p) => p.id === state.activeProjectId) ?? null)
      : null
  )
  const root = project ? (primaryRootOf(project)?.path ?? null) : null

  const [status, setStatus] = useState<CodeServerStatus | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  /**
   * The Host's base URL, or `null` when this shell is the host.
   *
   * Read once and held, because "which machine is the Host" does not change
   * without a re-pair, and the frame below must not flip between embedding and
   * refusing while the user is typing in it.
   */
  const [hostBaseUrl, setHostBaseUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const endpoint = await defaultCompanionEndpointResolver().catch(() => null)
      if (!cancelled) setHostBaseUrl(endpoint?.baseUrl ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const probe = useCallback(async () => {
    if (!root || !reach.available) return null
    // A host that cannot answer is reported as "not running" rather than as an
    // error: the card's job is to say what is true, and an unreachable host is
    // already visible through the surface notice above it.
    return codeServerClient.status(root).catch(() => null)
  }, [reach.available, root])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next = await probe()
      if (!cancelled) setStatus(next)
    })()
    return () => {
      cancelled = true
    }
  }, [probe])

  const start = useCallback(async () => {
    if (!root) return
    setBusy("start")
    try {
      setStatus(await codeServerClient.ensure(root))
    } catch (error) {
      toast.error(t("startFailed", { error: String(error) }))
    } finally {
      setBusy(null)
    }
  }, [root, t])

  const stop = useCallback(async () => {
    if (!root) return
    setBusy("stop")
    try {
      await codeServerClient.stop(root)
      setStatus(await probe())
    } catch (error) {
      toast.error(t("stopFailed", { error: String(error) }))
    } finally {
      setBusy(null)
    }
  }, [probe, root, t])

  const running = status?.running === true

  return (
    <Card data-testid="pro-ide-host-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("title")}
          {running ? (
            <Badge variant="secondary" data-testid="pro-ide-host-running">
              {t("running")}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {reach.available ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="pro-ide-host-root">
              {root ? t("boundTo", { root }) : t("noWorkspace")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={running ? "outline" : "default"}
                disabled={!root || busy !== null}
                onClick={running ? stop : start}
                data-testid="pro-ide-host-toggle"
              >
                {busy !== null ? (
                  <Spinner data-icon="inline-start" />
                ) : running ? (
                  <SquareIcon data-icon="inline-start" />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                {running ? t("stop") : t("start")}
              </Button>
            </div>
            {/*
              A browser on the host's own machine can embed the workbench over
              loopback. Everything else gets the sentence below instead, which
              is the honest answer rather than a frame that would sit blank.
            */}
            {running ? (
              <div
                className="h-[60vh] min-h-80 overflow-hidden rounded-stage border"
                data-testid="pro-ide-host-frame"
              >
                <CodeServerWebFrame status={status} hostBaseUrl={hostBaseUrl} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="pro-ide-host-where">
                {t("openWhere")}
              </p>
            )}
          </>
        ) : (
          <SurfaceUnavailableNotice reach={reach} data-testid="pro-ide-host-unavailable" />
        )}
      </CardContent>
    </Card>
  )
}
