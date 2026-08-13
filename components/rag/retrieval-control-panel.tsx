"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ShieldAlert, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  cancelStoredRetrievalJob,
  listRetrievalControlSnapshot,
  retryStoredRetrievalJob,
  setRetrievalKillSwitch,
} from "@/lib/db/retrieval-control"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { useAccountStore } from "@/stores/account/account-store"

export interface RetrievalControlPanelProps {
  corpusIds?: readonly string[]
  corpusPrefixes?: readonly string[]
  compact?: boolean
}

const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "retry_wait"])

function createManualJobId(): string {
  return `retrieval-job:${crypto.randomUUID()}`
}

export function RetrievalControlPanel({
  corpusIds = [],
  corpusPrefixes = [],
  compact = false,
}: RetrievalControlPanelProps) {
  const t = useTranslations("retrievalControl")
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const accountLocked = useAccountStore((state) => state.locked)
  const [error, setError] = useState(false)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)
  const snapshot = useLiveQuery(
    () => listRetrievalControlSnapshot({ corpusIds, corpusPrefixes }),
    [corpusIds.join("\u0000"), corpusPrefixes.join("\u0000")]
  )

  const activeGenerations = snapshot?.generations.filter((row) => row.status === "active") ?? []
  const activeJobs = snapshot?.jobs.filter((row) => ACTIVE_JOB_STATUSES.has(row.status)) ?? []
  const quarantined =
    (snapshot?.generations.filter((row) => row.status === "failed").length ?? 0) +
    (snapshot?.jobs.filter((row) => row.status === "failed").length ?? 0)
  const vaultLabel =
    isTauri() || isCapacitor()
      ? t("vault.secure")
      : !activeAccountId
        ? t("vault.unavailable")
        : accountLocked || !getActiveBrowserVault()?.isUnlocked()
          ? t("vault.locked")
          : t("vault.unlocked")

  const runJobAction = async (jobId: string, action: "cancel" | "retry") => {
    setBusyJobId(jobId)
    setError(false)
    try {
      if (action === "cancel") await cancelStoredRetrievalJob(jobId)
      else await retryStoredRetrievalJob(jobId, { id: createManualJobId() })
    } catch {
      setError(true)
    } finally {
      setBusyJobId(null)
    }
  }

  const setKillSwitch = async (engaged: boolean) => {
    setError(false)
    try {
      await setRetrievalKillSwitch({
        engaged,
        changedBy: "user",
        ...(engaged ? { reasonCode: "user_control_plane" } : {}),
      })
    } catch {
      setError(true)
    }
  }

  const hasRows = (snapshot?.generations.length ?? 0) > 0 || (snapshot?.jobs.length ?? 0) > 0

  return (
    <Card data-testid="retrieval-control-panel" data-account-revision={accountRevision}>
      <CardHeader className={compact ? "p-3 pb-2" : undefined}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {snapshot?.runtime.killSwitchEngaged ? (
              <ShieldAlert className="text-destructive size-4" aria-hidden="true" />
            ) : (
              <ShieldCheck className="text-primary size-4" aria-hidden="true" />
            )}
            {t("title")}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{vaultLabel}</Badge>
            {snapshot?.runtime.killSwitchEngaged ? (
              <Button size="sm" variant="outline" onClick={() => void setKillSwitch(false)}>
                {t("killSwitch.disable")}
              </Button>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline">
                    {t("killSwitch.enable")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("confirmKillSwitch.title")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("confirmKillSwitch.description")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("confirmKillSwitch.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void setKillSwitch(true)}>
                      {t("confirmKillSwitch.confirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className={compact ? "space-y-3 p-3 pt-0" : "space-y-4"}>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Metric label={t("metrics.activeGenerations")} value={activeGenerations.length} />
          <Metric label={t("metrics.activeJobs")} value={activeJobs.length} />
          <Metric label={t("metrics.quarantined")} value={quarantined} />
          <Metric label={t("metrics.traces")} value={snapshot?.traces.length ?? 0} />
        </div>

        {error ? (
          <p className="text-destructive text-xs" role="alert">
            {t("error")}
          </p>
        ) : null}

        {!hasRows ? <p className="text-muted-foreground text-xs">{t("empty")}</p> : null}

        {!compact && snapshot?.generations.length ? (
          <ul className="space-y-1">
            {snapshot.generations.slice(0, 8).map((generation) => (
              <li key={generation.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono">{generation.id}</span>
                <Badge variant={generation.status === "failed" ? "destructive" : "secondary"}>
                  {t(`generation.${generation.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        {!compact && snapshot?.jobs.length ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("jobs.title")}</p>
            <ul className="space-y-2">
              {snapshot.jobs.slice(0, 12).map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono">{job.id}</p>
                    <p className="text-muted-foreground">
                      {t(`jobs.${job.status}`)} · {job.kind} ·{" "}
                      {t("jobs.attempt", { attempt: job.attempt, maxAttempts: job.maxAttempts })}
                    </p>
                  </div>
                  {ACTIVE_JOB_STATUSES.has(job.status) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyJobId === job.id}
                      onClick={() => void runJobAction(job.id, "cancel")}
                    >
                      {t("actions.cancel")}
                    </Button>
                  ) : job.status === "failed" || job.status === "cancelled" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyJobId === job.id}
                      onClick={() => void runJobAction(job.id, "retry")}
                    >
                      {t("actions.retry")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-muted-foreground text-[11px]">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}
