"use client"

// The optional "Pro IDE" surface for the project editors: a native code-server
// (browser VS Code) webview pinned over this pane, downloaded on first use.
// Desktop-only; augments — never replaces — the Monaco editor. The webview
// itself is a single shared resource owned by `lib/codeserver/pane-manager`.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, MonitorXIcon, RotateCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useCodeServerPane } from "@/hooks/codeserver/use-code-server-pane"
import { useCodeServerThemeSync } from "@/hooks/codeserver/use-code-server-theme-sync"
import { codeServerClient } from "@/lib/codeserver/client"
import { createCodeServerOpenQueue } from "@/lib/codeserver/open-file-queue"
import { registerProjectEditorOpener } from "@/lib/files/project-editor-bridge"

interface Props {
  /** Project root code-server should open (the selected worktree root). */
  root: string
  /** Stable id for this surface in the shared-pane ownership handoff. */
  ownerId: string
  /** Called when another surface claims the shared pane away from this one. */
  onRevoked: () => void
}

export function CodeServerPane({ root, ownerId, onRevoked }: Props) {
  const t = useTranslations("projectEditor")
  const ref = useRef<HTMLDivElement>(null)
  const { phase, mounted, progress, error, retry } = useCodeServerPane(ref, {
    root,
    ownerId,
    onRevoked,
  })
  const percent = progress != null ? Math.round(progress * 100) : null
  // Paint code-server in the app palette. Kept outside the phase gate so the
  // very first spawn already reads a themed settings.json.
  useCodeServerThemeSync(true)
  // `ready` only means code-server answers; the native webview lands a beat
  // later. Holding the placeholder until it is actually mounted removes the
  // flash of bare background in between.
  const showPlaceholder = phase !== "ready" || !mounted

  // Register as the project-editor opener only once code-server can actually
  // service an open. Registering earlier guarantees a raw "code-server is not
  // running" toast for any jump that lands mid-download; the bridge holds a
  // deferred request instead and replays it when we register.
  useEffect(() => {
    if (phase !== "ready") return
    const queue = createCodeServerOpenQueue(
      (path, line, column) => codeServerClient.openFile(root, path, line, column),
      { onError: (cause) => toast.error(t("proIde.openFileFailed", { error: String(cause) })) }
    )
    const unregister = registerProjectEditorOpener({
      root,
      open: (path, line, column) => queue.request(path, line, column),
    })
    return () => {
      unregister()
      queue.dispose()
    }
  }, [phase, root, t])

  return (
    <div className="relative h-full w-full overflow-hidden" data-testid="code-server-pane">
      {/* Reserved region the native code-server webview is positioned over. */}
      <div ref={ref} className="absolute inset-0" data-testid="code-server-region" />

      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-6 text-center">
          {phase === "unsupported" ? (
            <div
              className="flex max-w-sm flex-col items-center gap-2"
              data-testid="code-server-unsupported"
            >
              <MonitorXIcon className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t("proIde.unsupportedTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("proIde.unsupportedDesc")}</p>
            </div>
          ) : phase === "error" ? (
            <div
              className="flex max-w-sm flex-col items-center gap-3"
              data-testid="code-server-error"
            >
              <p className="text-sm font-medium">{t("proIde.errorTitle")}</p>
              {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
              <Button size="sm" variant="outline" onClick={retry}>
                <RotateCwIcon className="size-3.5" />
                {t("proIde.retry")}
              </Button>
            </div>
          ) : (
            <div
              className="flex w-full max-w-xs flex-col items-center gap-2 text-sm text-muted-foreground"
              data-testid="code-server-loading"
            >
              <Loader2Icon className="size-5 animate-spin" />
              <span>
                {phase === "downloading" && percent != null
                  ? t("proIde.downloading", { percent })
                  : t("proIde.starting")}
              </span>
              {/* The first run pulls ~100-200MB; a bare percentage is a weak
                  affordance for a wait that long. */}
              {phase === "downloading" && percent != null ? (
                <Progress value={percent} className="h-1.5" data-testid="code-server-progress" />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
