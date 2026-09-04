"use client"

// The "Pro IDE" surface for a shell that has no native webview to pin.
//
// The desktop twin (`code-server-pane.tsx`) owns a native child webview and is
// unreachable off Tauri, which left every browser and phone with a toggle that
// said "not supported on this platform" even while the host it was paired with
// was perfectly capable of running the workbench. It is not the platform that
// decides, it is where the browser is standing: a tab on the host's own machine
// reaches the workbench over loopback, and one anywhere else cannot, because
// the only other route in authenticates every request and an iframe carries no
// bearer token. `lib/codeserver/web-embed.ts` holds that reasoning and
// `CodeServerWebFrame` renders both outcomes.
//
// What this component adds is the lifecycle around the frame: ensure the host
// has a workbench running for this root, and register it as the project-editor
// opener so terminal links, review jumps and agent file-follows land in it
// rather than falling back to the read-only viewer.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CodeServerWebFrame } from "./code-server-web-frame"
import { useCodeServerProjectOpener } from "@/hooks/codeserver/use-code-server-project-opener"
import {
  type CodeServerProfile,
  type CodeServerStatus,
  codeServerClient,
} from "@/lib/codeserver/client"
import { resolveWebWorkbenchTarget } from "@/lib/codeserver/web-embed"
import { defaultCompanionEndpointResolver } from "@/lib/tauri/companion-endpoint"

interface Props {
  /** Project root the host should serve. */
  root: string
  /** Which code-server trust domain to run in on the host. */
  profile?: CodeServerProfile
  /** Make the host's file surface visible before a bridge capability uses it. */
  beforeOpen?: () => void
}

type Phase = "starting" | "ready" | "error"

export function CodeServerWebPane({ root, profile = "managed", beforeOpen }: Props) {
  const t = useTranslations("projectEditor")
  const [phase, setPhase] = useState<Phase>("starting")
  const [status, setStatus] = useState<CodeServerStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  /**
   * The Host's base URL, or null when this shell IS the host.
   *
   * Resolved once and held. Which machine the Host is does not change without
   * a re-pair, and letting it flip would swap the frame for a refusal notice
   * (or the reverse) under a user who is working in it.
   */
  const [hostBaseUrl, setHostBaseUrl] = useState<string | null>(null)
  const [hostResolved, setHostResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const endpoint = await defaultCompanionEndpointResolver().catch(() => null)
      if (cancelled) return
      setHostBaseUrl(endpoint?.baseUrl ?? null)
      setHostResolved(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      setPhase("starting")
      try {
        // `ensure` rather than `status`: the browser is the surface the user
        // just switched to, so starting the workbench is the expected effect of
        // that switch. It is idempotent, so an already-running host is a
        // cheap round trip rather than a restart.
        const next = await codeServerClient.ensure(root, profile)
        if (cancelled) return
        setStatus(next)
        setPhase("ready")
      } catch (cause) {
        if (cancelled) return
        setError(String(cause))
        setPhase("error")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attempt, profile, root])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // Only once the workbench answers, and only when the frame can actually show
  // it. Registering while the user is looking at a "open it on the host's own
  // machine" notice would route every file jump into a window they cannot see,
  // which is worse than the read-only viewer they would otherwise get.
  //
  // `resolveWebWorkbenchTarget`, not `hostBaseUrl === null`. Those are two
  // different questions: null means "this shell IS the host", while a paired
  // browser on the host's own machine has a non-null LOOPBACK base URL and is
  // just as embeddable — which is exactly what the iframe beside this decides.
  // Asking the narrower question left every same-machine paired browser with a
  // visible, working IDE that no file jump ever landed in.
  const targetKind = resolveWebWorkbenchTarget({ status, hostBaseUrl }).kind
  // Framing is the half the target cannot answer: code-server may refuse it,
  // and then the frame shows an "open in a tab" link instead. Start from the
  // target so the opener is live on the first render the frame is shown, and
  // let the frame withdraw it if the embed never loads.
  const [framingRefused, setFramingRefused] = useState(false)
  const onEmbeddedChange = useCallback(
    (frameEmbedded: boolean) => setFramingRefused(!frameEmbedded),
    []
  )
  const embedded = phase === "ready" && hostResolved && targetKind === "embed" && !framingRefused
  useCodeServerProjectOpener({ root, enabled: embedded, beforeOpen })

  if (phase === "error") {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center"
        data-testid="code-server-web-error"
      >
        <p className="text-sm font-medium">{t("proIde.errorTitle")}</p>
        {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
        <Button size="sm" variant="outline" onClick={retry}>
          <RotateCwIcon className="size-3.5" />
          {t("proIde.retry")}
        </Button>
      </div>
    )
  }

  // Hold the spinner until BOTH answers are in. Rendering the frame on a
  // half-resolved host means `resolveWebWorkbenchTarget` sees `hostBaseUrl:
  // null`, reads it as "this shell is the host", and points an iframe at this
  // machine's loopback on the strength of a value that has not arrived yet.
  if (phase === "starting" || !hostResolved) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="code-server-web-loading"
      >
        <Loader2Icon className="size-5 animate-spin" />
        <span>{t("proIde.starting")}</span>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden" data-testid="code-server-web-pane">
      <CodeServerWebFrame
        status={status}
        hostBaseUrl={hostBaseUrl}
        onEmbeddedChange={onEmbeddedChange}
      />
    </div>
  )
}
