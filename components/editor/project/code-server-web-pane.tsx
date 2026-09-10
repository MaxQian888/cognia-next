"use client"

// Browser workbench lifecycle; shared hooks route editor operations to its host.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CodeServerWebFrame } from "./code-server-web-frame"
import { useCodeServerSettingsSync } from "@/hooks/codeserver/use-code-server-settings-sync"
import { useCodeServerLocaleSync } from "@/hooks/codeserver/use-code-server-locale-sync"
import { useCodeServerWorkspaceSync } from "@/hooks/codeserver/use-code-server-workspace-sync"
import { useCodeServerEditorEvents } from "@/hooks/codeserver/use-code-server-editor-events"
import { useCodeServerChatBridge } from "@/hooks/codeserver/use-code-server-chat-bridge"
import { toast } from "sonner"
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

export function CodeServerWebPane(props: Props) {
  return <WebWorkbenchSession key={`${props.root}:${props.profile ?? "managed"}`} {...props} />
}

function WebWorkbenchSession({ root, profile = "managed", beforeOpen }: Props) {
  const t = useTranslations("projectEditor")
  const [phase, setPhase] = useState<Phase>("starting")
  const [status, setStatus] = useState<CodeServerStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [hostBaseUrl, setHostBaseUrl] = useState<string | null>(null)
  const [hostResolved, setHostResolved] = useState(false)
  const [framingRefused, setFramingRefused] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      setPhase("starting")
      setHostResolved(false)
      setFramingRefused(false)
      try {
        // Identity failures must not become a null endpoint (local host).
        const endpoint = await defaultCompanionEndpointResolver()
        if (cancelled) return
        setHostBaseUrl(endpoint?.baseUrl ?? null)
        setHostResolved(true)
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
  const restart = useCallback(() => {
    setPhase("starting")
    void codeServerClient
      .stop(root)
      .then(retry)
      .catch((cause: unknown) => {
        setError(String(cause))
        setPhase("error")
      })
  }, [root, retry])

  // Headless instances do not have the desktop pane's process watchdog.
  // Check serially so a slow host never accumulates overlapping requests.
  useEffect(() => {
    if (phase !== "ready") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const next = await codeServerClient.status(root)
        if (cancelled) return
        if (next.profile && next.profile !== profile) {
          setPhase("error")
          setError(t("proIde.profileChanged"))
          return
        }
        if (!next.running) {
          setStatus(next)
          setPhase("error")
          setError(null)
          return
        }
        setStatus(next)
        timer = setTimeout(() => void check(), 5_000)
      } catch (cause) {
        if (cancelled) return
        setError(String(cause))
        setPhase("error")
      }
    }
    timer = setTimeout(() => void check(), 5_000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phase, profile, root, t])

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
  const onEmbeddedChange = useCallback(
    (frameEmbedded: boolean) => setFramingRefused(!frameEmbedded),
    []
  )
  const embedded = phase === "ready" && hostResolved && targetKind === "embed" && !framingRefused
  const managed = embedded && profile === "managed"
  useCodeServerProjectOpener({ root, enabled: embedded, beforeOpen })
  useCodeServerSettingsSync(phase === "ready", profile)
  useCodeServerLocaleSync(
    phase === "ready",
    {
      restart,
      onUntranslated: (locale) => toast.info(t("proIde.languageUnavailable", { locale })),
    },
    profile
  )
  useCodeServerWorkspaceSync(managed, root)
  useCodeServerEditorEvents(managed, root)
  useCodeServerChatBridge(managed, root)

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
