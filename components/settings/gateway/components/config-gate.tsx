"use client"

/**
 * Holds a config-backed gateway panel back until the persisted config is in.
 *
 * The section seeds its state with `DEFAULT_GATEWAY_CONFIG`, and every panel
 * edit is merged into that state before the whole document is written. A
 * panel shown before the load landed — or after it failed, which used to be
 * swallowed — displayed the defaults as if they were the saved values, and
 * the first edit wrote them back over the real config. The panel now mounts
 * only once the load succeeds; a failure says so and offers a retry.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

export type GatewayConfigLoadState =
  { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string }

export interface GatewayConfigGateProps {
  state: GatewayConfigLoadState
  retrying: boolean
  onRetry: () => void
  children: React.ReactNode
}

export function GatewayConfigGate({ state, retrying, onRetry, children }: GatewayConfigGateProps) {
  const t = useTranslations("settings.gateway")

  if (state.kind === "ready") return <>{children}</>

  if (state.kind === "loading") {
    return (
      <div
        className="flex flex-col gap-3"
        aria-busy="true"
        aria-label={t("configLoading")}
        data-testid="gateway-config-loading"
      >
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    )
  }

  return (
    <Alert variant="destructive" data-testid="gateway-config-error">
      <AlertTriangleIcon />
      <AlertTitle>{t("configLoadFailedTitle")}</AlertTitle>
      <AlertDescription className="flex w-full flex-col gap-2">
        <p>{t("configLoadFailed")}</p>
        <p className="break-words font-mono text-[11px]">{state.message}</p>
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={retrying}
          onClick={onRetry}
          data-testid="gateway-config-retry"
        >
          {retrying ? (
            <Spinner className="size-3.5" aria-hidden />
          ) : (
            <RefreshCwIcon className="size-3.5" aria-hidden />
          )}
          {t("configRetry")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
