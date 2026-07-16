"use client"

// The optional "Pro IDE" surface for the Agent Team Project Editor: a native
// code-server (browser VS Code) webview pinned over this pane, downloaded on
// first use. Desktop-only; augments — never replaces — the Monaco editor.

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, MonitorXIcon, RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useCodeServerPane } from "@/hooks/codeserver/use-code-server-pane"

interface Props {
  /** Project root code-server should open (the selected worktree root). */
  root: string
}

export function CodeServerPane({ root }: Props) {
  const t = useTranslations("projectEditor")
  const ref = useRef<HTMLDivElement>(null)
  const { phase, progress, error, retry } = useCodeServerPane(ref, { root, active: true })
  const percent = progress != null ? Math.round(progress * 100) : null

  return (
    <div className="relative h-full w-full overflow-hidden" data-testid="code-server-pane">
      {/* Reserved region the native code-server webview is positioned over. */}
      <div ref={ref} className="absolute inset-0" data-testid="code-server-region" />

      {phase !== "ready" && (
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
              className="flex flex-col items-center gap-2 text-sm text-muted-foreground"
              data-testid="code-server-loading"
            >
              <Loader2Icon className="size-5 animate-spin" />
              <span>
                {phase === "downloading" && percent != null
                  ? t("proIde.downloading", { percent })
                  : t("proIde.starting")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
