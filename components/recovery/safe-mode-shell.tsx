"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"
import { AlertTriangle, CheckCircle2, CircleDashed, MinusCircle, XCircle } from "lucide-react"

import {
  RECOVERY_ORDER,
  recoverySuspect,
  type RecoveryStateV1,
  type RecoverySubsystem,
} from "@cognia/logging"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { settingsHref } from "@/lib/settings/deep-link"
import type { RecoveryRetryAction } from "@/lib/tauri/recovery"

/**
 * The diagnostics shell (ADR-0102 §4).
 *
 * Deliberately austere: it renders from `RecoveryStateV1` and nothing else, and
 * it links out rather than embedding. Everything it can reach is either
 * read-only local data or a diagnostic action — no plugin surface, no
 * connector, no workflow, because those are exactly the subsystems that have
 * not been cleared yet.
 */

const STATUS_ICON = {
  passed: CheckCircle2,
  failed: XCircle,
  skipped: MinusCircle,
  pending: CircleDashed,
} as const

const STATUS_TONE = {
  passed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  pending: "text-muted-foreground",
} as const

export interface SafeModeShellProps {
  state: RecoveryStateV1 | null
  probing: boolean
  onRetry: (subsystem: RecoverySubsystem, action?: RecoveryRetryAction) => void
  /**
   * The secure-storage unlock notice, owned by the recovery gate. Shown above
   * the checkpoints so a locked keychain always has a Retry in diagnostics
   * mode, whichever subsystem put the app here.
   */
  secretStoreNotice?: ReactNode
}

export function SafeModeShell({ state, probing, onRetry, secretStoreNotice }: SafeModeShellProps) {
  const t = useTranslations("safeMode")
  const suspect = state ? recoverySuspect(state) : undefined
  const checkpoints = state?.checkpoints?.length ? state.checkpoints : null
  // Cold boot resets checkpoints to pending while preserving the suspect.
  // Retry still re-runs the ordered sequence; pending never offers keep-off.
  const pendingRetry =
    checkpoints?.find(
      (checkpoint) => checkpoint.status === "pending" && checkpoint.subsystem === suspect?.subsystem
    )?.subsystem ??
    (checkpoints?.some(
      (checkpoint) =>
        checkpoint.status === "failed" || state?.disabledSubsystems.includes(checkpoint.subsystem)
    )
      ? undefined
      : RECOVERY_ORDER.find((subsystem) =>
          checkpoints?.some(
            (checkpoint) => checkpoint.subsystem === subsystem && checkpoint.status === "pending"
          )
        ))

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-start gap-3">
        <AlertTriangle className="mt-1 size-6 shrink-0 text-amber-500" aria-hidden />
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
      </header>

      {secretStoreNotice}

      {suspect ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("suspect.title")}</CardTitle>
            <CardDescription>
              {suspect.subsystem
                ? t("suspect.subsystem", { subsystem: t(`subsystem.${suspect.subsystem}`) })
                : t("suspect.unknownSubsystem")}
            </CardDescription>
          </CardHeader>
          {suspect.reasonCode ? (
            <CardContent>
              <Badge variant="outline" className="font-mono text-xs">
                {suspect.reasonCode}
              </Badge>
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {t("checkpoints.title")}
            {probing ? (
              <Spinner className="size-4 text-muted-foreground" label={t("checkpoints.running")} />
            ) : null}
          </CardTitle>
          <CardDescription>{t("checkpoints.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {checkpoints ? (
            checkpoints.map((checkpoint) => {
              const Icon = STATUS_ICON[checkpoint.status]
              const disabled = state?.disabledSubsystems.includes(checkpoint.subsystem) ?? false
              return (
                <div
                  key={checkpoint.subsystem}
                  className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2"
                >
                  <Icon
                    className={cn("size-4 shrink-0", STATUS_TONE[checkpoint.status])}
                    aria-hidden
                  />
                  <span className="font-medium">{t(`subsystem.${checkpoint.subsystem}`)}</span>
                  <span className="text-muted-foreground text-xs">
                    {t(`status.${checkpoint.status}`)}
                  </span>
                  {checkpoint.reasonCode ? (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {checkpoint.reasonCode}
                    </Badge>
                  ) : null}
                  {disabled ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {t("status.disabled")}
                    </Badge>
                  ) : null}
                  {checkpoint.status === "failed" ||
                  disabled ||
                  checkpoint.subsystem === pendingRetry ? (
                    <div className="ms-auto flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={probing}
                        onClick={() => onRetry(checkpoint.subsystem, "retry")}
                      >
                        {t("actions.retry")}
                      </Button>
                      {disabled || checkpoint.status !== "failed" ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={probing}
                          onClick={() => onRetry(checkpoint.subsystem, "keep-disabled")}
                        >
                          {t("actions.keepDisabled")}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })
          ) : (
            <p className="text-muted-foreground text-sm">{t("checkpoints.empty")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("available.title")}</CardTitle>
          <CardDescription>{t("available.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/logs">{t("available.logs")}</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={settingsHref("data")}>{t("available.backup")}</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={settingsHref("about")}>{t("available.about")}</Link>
          </Button>
        </CardContent>
      </Card>

      {state ? (
        <p className="text-muted-foreground text-xs">
          {t("buildFooter", { buildId: state.buildId })}
        </p>
      ) : null}
    </main>
  )
}

/** The six groups, in recovery order — exported so tests can assert coverage. */
export const SAFE_MODE_SUBSYSTEMS: readonly RecoverySubsystem[] = RECOVERY_ORDER
