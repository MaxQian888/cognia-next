"use client"

// The workbench, in a browser tab on the host's own machine.
//
// The desktop shell pins a native child webview over a reserved region and
// never uses this. A browser cannot do that, and for an off-machine browser
// there is nothing to render at all: the only route in is the relay, which
// authenticates the device on every request, and an iframe has no way to send
// a bearer token. `resolveWebWorkbenchTarget` is where that decision lives.
//
// What this component adds on top of the decision is the one thing the
// decision cannot know in advance: whether code-server will consent to being
// framed. Upstream sets its own CSP, `frame-ancestors` included in some
// builds, and a refused frame does not throw and does not fire `error`. It
// simply never loads. So the frame is given a deadline, and missing it swaps
// in the same link the user would have got if embedding were impossible.
// Opening the workbench in its own tab is what Gitpod and Codespaces do
// anyway.

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { UnavailableNotice } from "@/components/connectors/unavailable-notice"
import { resolveWebWorkbenchTarget, type WebWorkbenchTarget } from "@/lib/codeserver/web-embed"
import type { CodeServerStatus } from "@/lib/codeserver/client"
import { cn } from "@/lib/utils"

/**
 * How long the frame has to report a load before it is treated as refused.
 *
 * Generous on purpose: this is a first paint of a whole VS Code, on loopback,
 * and calling it refused early would replace a working embed with a link.
 */
export const FRAME_LOAD_BUDGET_MS = 12_000

export interface CodeServerWebFrameProps {
  status: CodeServerStatus | null
  /** `null` when this shell is the host. */
  hostBaseUrl: string | null
  className?: string
  /** Test seam for the load deadline. */
  loadBudgetMs?: number
  /**
   * Fires when the frame starts, and stops, showing the workbench.
   *
   * Whether code-server consents to being framed is the one thing
   * `resolveWebWorkbenchTarget` cannot know in advance, so a caller that acts
   * on the workbench being on screen — registering it as the project-editor
   * opener, say — cannot derive it from the target alone.
   */
  onEmbeddedChange?: (embedded: boolean) => void
}

export function CodeServerWebFrame({
  status,
  hostBaseUrl,
  className,
  loadBudgetMs = FRAME_LOAD_BUDGET_MS,
  onEmbeddedChange,
}: CodeServerWebFrameProps) {
  const t = useTranslations("projectEditor.proIde.webFrame")
  const target: WebWorkbenchTarget = resolveWebWorkbenchTarget({ status, hostBaseUrl })
  const embedUrl = target.kind === "embed" ? target.url : null

  /**
   * Which URL was refused, rather than a boolean.
   *
   * A boolean would need clearing whenever the URL changes, and clearing it in
   * the effect that arms the deadline is a render-phase write. Keyed by URL
   * the reset is free: a restarted workbench comes back on a different port,
   * so the old refusal stops matching on its own.
   */
  const [refusedUrl, setRefusedUrl] = useState<string | null>(null)
  const refused = embedUrl !== null && refusedUrl === embedUrl
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!embedUrl) return
    loadedRef.current = false
    const timer = setTimeout(() => {
      if (!loadedRef.current) setRefusedUrl(embedUrl)
    }, loadBudgetMs)
    return () => clearTimeout(timer)
  }, [embedUrl, loadBudgetMs])

  const onLoad = useCallback(() => {
    loadedRef.current = true
  }, [])

  const embedded = embedUrl !== null && !refused
  const onEmbeddedChangeRef = useRef(onEmbeddedChange)
  useEffect(() => {
    onEmbeddedChangeRef.current = onEmbeddedChange
  }, [onEmbeddedChange])
  useEffect(() => {
    onEmbeddedChangeRef.current?.(embedded)
    // Unmounting takes the workbench off screen just as surely as a refusal.
    return () => onEmbeddedChangeRef.current?.(false)
  }, [embedded])

  if (!embedUrl) {
    const reason = target.kind === "unavailable" ? target.reason : "not-running"
    return (
      <UnavailableNotice
        reason={t(`reason.${reason}`)}
        cause={reason}
        data-testid="code-server-web-frame-unavailable"
        className={className}
      />
    )
  }

  if (refused) {
    return (
      <UnavailableNotice
        reason={t("reason.framing-refused")}
        cause="framing-refused"
        data-testid="code-server-web-frame-refused"
        className={className}
        action={
          <Button asChild size="sm" variant="outline">
            {/* `noopener` because the workbench runs with `--auth none`: a
                child window holding `window.opener` on a page that can already
                do anything on this machine is not a handle worth giving out. */}
            <a href={embedUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon data-icon="inline-start" />
              {t("openInTab")}
            </a>
          </Button>
        }
      />
    )
  }

  return (
    <iframe
      // Not sandboxed. The workbench needs same-origin storage, workers and
      // clipboard to function, and it is served from this machine's own
      // loopback by a process this app spawned, so a sandbox here would buy
      // nothing against an attacker already inside that boundary.
      src={embedUrl}
      title={t("title")}
      data-testid="code-server-web-frame"
      onLoad={onLoad}
      className={cn("h-full w-full border-0 bg-background", className)}
      allow="clipboard-read; clipboard-write"
    />
  )
}
