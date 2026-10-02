"use client"

import { useTranslations } from "next-intl"
import { RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { describeCodeServerError } from "@/lib/codeserver/error-messages"
import { cn } from "@/lib/utils"

interface Props {
  /** The failure as the pane received it; `null` when the instance just stopped. */
  error: unknown
  onRetry: () => void
  className?: string
  "data-testid"?: string
}

/**
 * Why the Pro IDE could not start, and what to do about it.
 *
 * Shared by the desktop pane and the browser pane, which used to print the
 * host's raw error string under a generic title.
 */
export function CodeServerErrorNotice({ error, onRetry, className, ...rest }: Props) {
  const t = useTranslations("projectEditor.proIde")
  const tErrors = useTranslations("projectEditor.proIde.errors")
  const view = error == null ? null : describeCodeServerError(error, tErrors)

  return (
    <div
      className={cn("flex max-w-sm flex-col items-center gap-2 text-center", className)}
      data-testid={rest["data-testid"]}
      data-error-code={view?.code ?? undefined}
    >
      <p className="text-sm font-medium">{t("errorTitle")}</p>
      {view ? (
        <>
          <p className="text-xs text-muted-foreground">{view.message}</p>
          <p className="text-xs text-muted-foreground">{view.hint}</p>
          {view.detail ? (
            <p
              className="max-h-24 overflow-auto font-mono text-[11px] break-all text-muted-foreground/80"
              data-testid="code-server-error-detail"
            >
              {view.detail}
            </p>
          ) : null}
        </>
      ) : null}
      <Button size="sm" variant="outline" className="mt-1" onClick={onRetry}>
        <RotateCwIcon className="size-3.5" />
        {t("retry")}
      </Button>
    </div>
  )
}
