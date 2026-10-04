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
import {
  useActiveHostSupportsFeature,
  useRemoteHostStore,
} from "@/stores/remote-host/remote-host-store"
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
   *
   * Subscribed, not read once: a desktop can switch its active remote host
   * (ADR-0082) while this card is open, and the manifest only lands once the
   * new host's probe settles. A one-shot read kept the previous host's answer.
   */
  const hostProvides = useActiveHostSupportsFeature("pro-ide", "codeserver_ensure")
  /**
   * Which remote host a desktop is driving, or `null` when it drives itself (and
   * always `null` on a phone or a browser, whose host lives in the companion
   * target book instead). Only used as a key: it changes exactly when the
   * machine behind every call below changes, and on nothing else.
   */
  const activeHostId = useRemoteHostStore((state) => state.activeHostId)
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
   * Resolved once per active host and held between switches. On a phone or a
   * browser the host is fixed by the pairing, so this resolves once. On a
   * desktop it is not: the user can attach to a remote host, switch to another
   * one or detach while this card is open, and a value read once at mount kept
   * pointing the frame at whichever machine was active then. So the effect is
   * keyed on `activeHostId` and nothing else: it re-resolves when the Host
   * actually changes, and the frame below still never flips between embedding
   * and refusing while the user is typing in it, because no ordinary re-render
   * re-runs it. The store installs the new endpoint on the routing plane before
   * it publishes the new id, so the resolver already sees the new host here.
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
  }, [activeHostId])

  const probe = useCallback(async () => {
    if (!root || !reach.available) return null
    // A host that cannot answer is reported as "not running" rather than as an
    // error: the card's job is to say what is true, and an unreachable host is
    // already visible through the surface notice above it.
    return codeServerClient.status(root).catch(() => null)
  }, [reach.available, root])

  // `activeHostId` is a dependency even though the body does not read it: a
  // switch between two hosts that both run a workbench leaves `probe` itself
  // unchanged, and without the key the card would keep showing the previous
  // host's running state against the new one.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next = await probe()
      if (!cancelled) setStatus(next)
    })()
    return () => {
      cancelled = true
    }
  }, [probe, activeHostId])

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
