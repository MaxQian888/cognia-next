"use client"

/**
 * What is actually installed behind the configured Agents, and whether Cognia
 * has certified it.
 *
 * The catalog, the version probe and the certification policy all existed
 * before this panel and none of them were reachable from the UI: nothing called
 * `inspectRuntime`, so a verdict was computed for no one. This is the surface
 * that consumes them.
 *
 * It lists only the runtimes the saved Agents actually bind to, rather than
 * every catalogued runtime. Two reasons: a probe spawns a process with a
 * multi-second timeout, so sweeping all fifteen would spend a minute of the
 * user's machine on runtimes they do not use; and a runtime nobody references
 * has nothing to say beyond "not installed", which is not news.
 *
 * @see lib/ai/agent/external/lifecycle/service.ts
 * @see lib/ai/agent/external/runtime-version.ts for what each verdict means
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  BadgeCheck,
  CircleHelp,
  ExternalLink,
  PackageX,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { runsExternalAgentProcessesLocally } from "@/lib/ai/agent/external/agent-transport"
import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import { findRuntimeById, isUnpinnedLaunch } from "@/lib/ai/agent/external/runtime-catalog"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type {
  ExternalAgentRuntimeStatus,
  ExternalAgentVersionVerdict,
} from "@/types/agent/external-agent-lifecycle"
import { cn } from "@/lib/utils"

/** One runtime's row: either the status, or why it could not be read. */
export interface RuntimeGovernanceRow {
  runtimeId: string
  status?: ExternalAgentRuntimeStatus
  error?: unknown
}

export interface RuntimeGovernancePanelProps {
  /**
   * Loads one runtime's status. Defaults to the lifecycle service; injectable
   * so a test can drive every verdict without a host that has processes.
   */
  inspectRuntime?: (runtimeId: string) => Promise<ExternalAgentRuntimeStatus>
  /** Whether this host can see installed runtimes at all. */
  hostSupported?: boolean
}

const VERDICT_ICON: Record<
  ExternalAgentVersionVerdict,
  { icon: typeof BadgeCheck; className: string; variant: "default" | "secondary" | "destructive" }
> = {
  certified: { icon: BadgeCheck, className: "text-emerald-600", variant: "default" },
  "supported-uncertified": {
    icon: ShieldQuestion,
    className: "text-amber-600",
    variant: "secondary",
  },
  unsupported: { icon: AlertTriangle, className: "text-destructive", variant: "destructive" },
  unparseable: { icon: CircleHelp, className: "text-muted-foreground", variant: "secondary" },
  missing: { icon: PackageX, className: "text-muted-foreground", variant: "secondary" },
}

const VERDICT_KEY: Record<ExternalAgentVersionVerdict, string> = {
  certified: "certified",
  "supported-uncertified": "supportedUncertified",
  unsupported: "unsupported",
  unparseable: "unparseable",
  missing: "missing",
}

async function defaultInspectRuntime(runtimeId: string): Promise<ExternalAgentRuntimeStatus> {
  const { getExternalAgentLifecycleService } =
    await import("@/lib/ai/agent/external/lifecycle/service")
  return (await getExternalAgentLifecycleService()).inspectRuntime(runtimeId)
}

export function RuntimeGovernancePanel({
  inspectRuntime = defaultInspectRuntime,
  hostSupported = runsExternalAgentProcessesLocally(),
}: RuntimeGovernancePanelProps = {}) {
  const t = useTranslations("externalAgent.runtimes")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")
  const agents = useExternalAgentStore((state) => state.agents)

  // Only what the saved Agents actually run. `runtimeBinding` is written when a
  // config is created and backfilled at startup, so an Agent configured before
  // the catalog existed still appears here.
  const runtimeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const agent of Object.values(agents)) {
      const runtimeId = agent.runtimeBinding?.runtimeId
      if (runtimeId) ids.add(runtimeId)
    }
    return [...ids].sort()
  }, [agents])

  // The result carries the request it answers, so "is a check in flight" is
  // derived rather than a second piece of state an effect has to set. That also
  // keeps the previous verdicts on screen while a re-check runs, instead of
  // blanking the panel between the click and the answer.
  const [request, setRequest] = useState(0)
  const [result, setResult] = useState<{ request: number; rows: RuntimeGovernanceRow[] }>()

  const inspectable = hostSupported && runtimeIds.length > 0
  const rows = result?.rows ?? []
  const loading = inspectable && result?.request !== request

  useEffect(() => {
    if (!inspectable) return
    let cancelled = false

    void Promise.all(
      runtimeIds.map(async (runtimeId): Promise<RuntimeGovernanceRow> => {
        try {
          return { runtimeId, status: await inspectRuntime(runtimeId) }
        } catch (error) {
          // One runtime failing must not blank the whole panel — the other
          // verdicts are still true.
          return { runtimeId, error }
        }
      })
    ).then((settled) => {
      if (!cancelled) setResult({ request, rows: settled })
    })

    return () => {
      cancelled = true
    }
  }, [inspectable, inspectRuntime, request, runtimeIds])

  return (
    <Card data-testid="runtime-governance-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRequest((previous) => previous + 1)}
            disabled={loading || !inspectable}
            data-testid="runtime-governance-refresh"
          >
            <RefreshCw
              className={cn("mr-2 size-4", loading && "animate-spin")}
              aria-hidden="true"
            />
            {t("refresh")}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {!hostSupported ? (
          <p
            className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
            data-testid="runtime-governance-unsupported"
          >
            {t("hostCannotInspect")}
          </p>
        ) : runtimeIds.length === 0 ? (
          <Empty className="border-0 py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageX className="size-6" />
              </EmptyMedia>
              <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : loading && rows.length === 0 ? (
          <div className="space-y-2" data-testid="runtime-governance-loading">
            {runtimeIds.map((runtimeId) => (
              <Skeleton key={runtimeId} className="h-20 w-full" />
            ))}
          </div>
        ) : (
          rows.map((row) => <RuntimeRow key={row.runtimeId} row={row} t={t} tErrors={tErrors} />)
        )}
      </CardContent>
    </Card>
  )
}

type Translator = ReturnType<typeof useTranslations>

function RuntimeRow({
  row,
  t,
  tErrors,
}: {
  row: RuntimeGovernanceRow
  t: Translator
  tErrors: Translator
}) {
  const entry = findRuntimeById(row.runtimeId)
  const name = entry?.displayName ?? row.runtimeId

  if (row.error || !row.status) {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
        data-testid={`runtime-row-${row.runtimeId}`}
      >
        <p className="text-sm font-medium">{name}</p>
        <p className="mt-1 text-xs text-destructive">
          {lifecycleErrorMessage(row.error, (key) => tErrors(key))}
        </p>
      </div>
    )
  }

  const { assessment, ownership, referencedBy, activeSessionCount } = row.status
  const verdict = VERDICT_ICON[assessment.verdict]
  const VerdictIcon = verdict.icon

  return (
    <div
      className="space-y-2 rounded-md border px-3 py-2"
      data-testid={`runtime-row-${row.runtimeId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
        <Badge variant="outline" className="text-[10px]">
          {t(`ownership.${ownership}`)}
        </Badge>
        <Badge
          variant={verdict.variant}
          className="gap-1 text-[10px]"
          data-testid={`runtime-verdict-${row.runtimeId}`}
        >
          <VerdictIcon className={cn("size-3", verdict.className)} aria-hidden="true" />
          {t(`verdict.${VERDICT_KEY[assessment.verdict]}`)}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(`verdictHelp.${VERDICT_KEY[assessment.verdict]}`)}
      </p>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Field
          label={t("detectedVersion")}
          value={assessment.detectedVersion ?? t("versionUnknown")}
        />
        <Field
          label={t("supportedRange")}
          value={assessment.supportedRange ?? t("noSupportedRange")}
        />
        {assessment.executablePath ? (
          <Field label={t("executable")} value={assessment.executablePath} mono />
        ) : null}
        <Field label={t("usedBy")} value={String(referencedBy.length)} />
        <Field label={t("activeSessions")} value={String(activeSessionCount)} />
      </dl>

      {/* An `npx -y <pkg>` launch re-downloads the package on every start, so
          the version above describes the last run, not necessarily the next. */}
      {entry && isUnpinnedLaunch(entry) ? (
        <p
          className="rounded-sm bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
          data-testid={`runtime-unpinned-${row.runtimeId}`}
        >
          {t("unpinnedLaunch")}
        </p>
      ) : null}

      {entry?.docsUrl ? (
        <a
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          href={entry.docsUrl}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink className="size-3" aria-hidden="true" />
          {t("openDocs")}
        </a>
      ) : null}
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate", mono && "font-mono")}>{value}</dd>
    </div>
  )
}
