"use client"

/**
 * Source-side projection of workflow handoffs (ADR-0136 §6).
 *
 * When a published workflow's `runOn` is `pinned` or `auto`, the trigger is
 * durably enqueued on `hostDispatchQueue` and executed on another Host. The
 * run then exists *there* — the source has no `workflowRuns` row for it, so the
 * Runs page rendered an empty history for a workflow that was firing normally.
 *
 * This is deliberately a pointer, not a mirror. The source shows what it
 * genuinely knows — dispatch status, which Host, the run the target minted, and
 * why a delivery failed — and offers to open the target Host to see the rest.
 * Mirroring the remote event log would give one run two journals that drift.
 *
 * Cancelling is split along the same line. Before the target admits the work
 * there is nothing there to stop and the source owns the occurrence, so it can
 * cancel. Once `remoteRunId` exists the run is the target's; cancelling here
 * would strand it, so the only offer is to go there and cancel it properly.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, RadioTowerIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cancelHostDispatch } from "@/lib/db/host-dispatch-queue"
import { getDb } from "@/lib/db/schema"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import type { HostDispatchJobRow, HostDispatchStatus } from "@/types/placement/host-dispatch"

/** Newest first, and bounded — this is a status strip, not a second history. */
const MAX_ROWS = 10

const ACTIVE_STATUSES: ReadonlySet<HostDispatchStatus> = new Set(["pending", "inflight"])
const FAILED_STATUSES: ReadonlySet<HostDispatchStatus> = new Set(["failed", "deadletter"])

function badgeVariant(status: HostDispatchStatus): "default" | "secondary" | "destructive" {
  if (FAILED_STATUSES.has(status)) return "destructive"
  return ACTIVE_STATUSES.has(status) ? "default" : "secondary"
}

/**
 * `targetRef` is the target's stable `hostIdentity.id`, never this machine's
 * randomly-minted `RemoteHost.id` — matching on the latter would break the
 * moment the same Host was re-paired.
 */
export function findHostByIdentity(
  hosts: readonly RemoteHost[],
  targetRef: string
): RemoteHost | undefined {
  return hosts.find((host) => {
    const manifest = host.featureManifest
    // Only a v2 manifest carries a stable host identity; a v1 Host predates
    // placement entirely and can never be a handoff target.
    return manifest?.schemaVersion === 2 && manifest.hostIdentity.id === targetRef
  })
}

export interface WorkflowHandoffPanelProps {
  workflowId: string
  /** Injected in tests so a case never installs a real remote transport. */
  onOpenTarget?: (host: RemoteHost) => void
}

export function WorkflowHandoffPanel({ workflowId, onOpenTarget }: WorkflowHandoffPanelProps) {
  const t = useTranslations("workflows.runs.handoff")
  const router = useRouter()
  const hosts = useRemoteHostStore((state) => state.hosts)
  const activateHost = useRemoteHostStore((state) => state.activateHost)

  const rows = useLiveQuery(
    async () => {
      const all = await getDb()
        .hostDispatchQueue.filter(
          (row) => row.domain === "schedule-handoff" && row.label === workflowId
        )
        .toArray()
      return all.sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_ROWS)
    },
    [workflowId],
    [] as HostDispatchJobRow[]
  )

  if (rows.length === 0) return null

  const openTarget = (host: RemoteHost) => {
    if (onOpenTarget) {
      onOpenTarget(host)
      return
    }
    activateHost(host.id)
    router.push(`/workflows/runs?id=${encodeURIComponent(workflowId)}`)
  }

  const cancel = async (row: HostDispatchJobRow) => {
    try {
      await cancelHostDispatch(row.id, "cancelled_by_source")
      toast.success(t("cancelled"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="border-b px-6 py-3" data-testid="workflow-handoff-panel">
      <div className="mb-2 flex items-center gap-2">
        <RadioTowerIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => {
          const host = findHostByIdentity(hosts, row.targetRef)
          const admitted = Boolean(row.remoteRunId)
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs"
              data-testid="workflow-handoff-row"
              data-status={row.status}
            >
              <Badge variant={badgeVariant(row.status)} className="text-[10px]">
                {t(`status.${row.status}`)}
              </Badge>
              <span className="font-medium" data-testid="workflow-handoff-target">
                {host?.label || row.targetRef}
              </span>
              {row.remoteRunId ? (
                <span
                  className="font-mono text-muted-foreground"
                  data-testid="workflow-handoff-run"
                >
                  {t("remoteRun", { runId: row.remoteRunId })}
                </span>
              ) : null}
              {FAILED_STATUSES.has(row.status) ? (
                <span className="text-destructive" data-testid="workflow-handoff-reason">
                  {t("reason", {
                    code: row.terminalCode ?? "unknown",
                    error: row.lastError ?? "",
                  })}
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-1">
                {host ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => openTarget(host)}
                    data-testid="workflow-handoff-open"
                  >
                    <ExternalLinkIcon className="mr-1 size-3" aria-hidden="true" />
                    {t("openTarget")}
                  </Button>
                ) : (
                  <span className="text-muted-foreground" data-testid="workflow-handoff-unpaired">
                    {t("targetNotPaired")}
                  </span>
                )}
                {ACTIVE_STATUSES.has(row.status) && !admitted ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => void cancel(row)}
                    data-testid="workflow-handoff-cancel"
                  >
                    <XIcon className="mr-1 size-3" aria-hidden="true" />
                    {t("cancel")}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
