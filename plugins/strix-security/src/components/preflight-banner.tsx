"use client"

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react"
import { Alert, AlertDescription } from "@cognia/plugin-ui"
import { Button } from "@cognia/plugin-ui"
import type { PreflightStatus } from "../types"
import { usePluginT } from "../use-plugin-t"

interface Props {
  status: PreflightStatus | null
  checking: boolean
  onRecheck: () => void
}

export function PreflightBanner({ status, checking, onRecheck }: Props) {
  const t = usePluginT()

  if (checking || !status) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border p-2 text-xs text-muted-foreground"
        data-testid="strix-preflight-checking"
      >
        <Loader2 className="size-3.5 animate-spin" />
        {t("preflight.checking")}
      </div>
    )
  }

  if (status.docker && status.strix) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-400"
        data-testid="strix-preflight-ok"
      >
        <CheckCircle2 className="size-3.5" />
        <span>{t("preflight.ready")}</span>
        {status.strixVersion && (
          <span className="ml-auto font-mono">
            {t("preflight.strixVersion", { version: status.strixVersion })}
          </span>
        )}
      </div>
    )
  }

  return (
    <Alert variant="destructive" data-testid="strix-preflight-blocked">
      <AlertTriangle className="size-4" />
      <AlertDescription>
        <ul className="list-inside list-disc">
          {!status.docker && <li>{t("preflight.dockerMissing")}</li>}
          {!status.strix && <li>{t("preflight.strixMissing")}</li>}
        </ul>
        <p className="mt-1">{t("preflight.install")}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onRecheck}
          data-testid="strix-preflight-retry"
        >
          <RefreshCw className="size-3.5" />
          {t("preflight.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
