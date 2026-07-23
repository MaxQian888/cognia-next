"use client"

/**
 * PerfManagedProcesses — the "Managed Processes" tab. Lists every child process
 * cognia spawned (external agents, chat sidecar, ACP + PTY terminals, MCP
 * server), grouped by owning subsystem, joined to the OS process by `pid` for
 * live CPU / memory / uptime, with kill + restart controls.
 *
 * Reads the managed set off the latest `perf://sample` frame (`latest.managed`)
 * so it rides the same sampler the rest of the panel uses; control actions are
 * routed by `controlManaged` (external agents → renderer manager, everything
 * else → the native `control_managed_process` command).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BoxesIcon, CpuIcon, MemoryStickIcon, PlayIcon, RotateCwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { StatCard } from "@/components/observability/stat-card"
import { cn, formatDurationShort } from "@/lib/utils"
import { formatBytes, formatCount, formatPercent } from "@/lib/perf/backend/format"
import { controlManaged } from "@/lib/perf/backend/managed-control"
import type {
  ManagedProcess,
  ManagedStatus,
  ManagedSubsystem,
  PerfSample,
  ProcessSample,
} from "@/lib/perf/backend/types"

/**
 * Display rank per subsystem group (most agent-relevant first).
 *
 * A `Record` rather than an array: grouping *filters* by this order, so a
 * subsystem missing from it is silently dropped from the panel — a new backend
 * subsystem would be collected, killed on exit, and still invisible. Keying on
 * the union makes omitting one a type error.
 */
const SUBSYSTEM_RANK: Record<ManagedSubsystem, number> = {
  externalAgent: 0,
  chatSidecar: 1,
  mcpServer: 2,
  codeServer: 3,
  pluginHost: 4,
  acpTerminal: 5,
  integratedTerminal: 6,
  headlessTerminal: 7,
  tunnel: 8,
}

const SUBSYSTEM_ORDER = (Object.keys(SUBSYSTEM_RANK) as ManagedSubsystem[]).sort(
  (a, b) => SUBSYSTEM_RANK[a] - SUBSYSTEM_RANK[b]
)

/** Status badge tint by lifecycle state. */
const STATUS_BADGE: Record<ManagedStatus, string> = {
  running: "bg-chart-4/15 text-chart-4",
  starting: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  stopping: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  stopped: "bg-muted text-muted-foreground",
  error: "bg-red-500/20 text-red-600 dark:text-red-400",
}

export interface PerfManagedProcessesProps {
  latest: PerfSample | null
}

interface JoinedRow {
  mp: ManagedProcess
  proc: ProcessSample | null
}

export function PerfManagedProcesses({ latest }: PerfManagedProcessesProps) {
  const t = useTranslations("performance.managed")
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmKill, setConfirmKill] = useState<ManagedProcess | null>(null)

  const managed = useMemo(() => latest?.managed ?? [], [latest])

  // Join managed rows to their OS process sample (CPU / memory / uptime) by PID.
  const procByPid = useMemo(() => {
    const map = new Map<number, ProcessSample>()
    for (const p of latest?.processes ?? []) map.set(p.pid, p)
    return map
  }, [latest])

  const joined = useMemo<JoinedRow[]>(
    () =>
      managed.map((mp) => ({
        mp,
        proc: mp.pid != null ? (procByPid.get(mp.pid) ?? null) : null,
      })),
    [managed, procByPid]
  )

  const totals = useMemo(() => {
    let cpu = 0
    let mem = 0
    let running = 0
    for (const { mp, proc } of joined) {
      if (proc) {
        cpu += proc.cpuPct
        mem += proc.memBytes
      }
      if (mp.status === "running") running += 1
    }
    return { cpu, mem, running }
  }, [joined])

  const groups = useMemo(() => {
    const bySubsystem = new Map<ManagedSubsystem, JoinedRow[]>()
    for (const row of joined) {
      const arr = bySubsystem.get(row.mp.subsystem) ?? []
      arr.push(row)
      bySubsystem.set(row.mp.subsystem, arr)
    }
    return SUBSYSTEM_ORDER.filter((s) => bySubsystem.has(s)).map((subsystem) => ({
      subsystem,
      rows: bySubsystem.get(subsystem)!,
    }))
  }, [joined])

  const runAction = async (mp: ManagedProcess, action: "kill" | "restart") => {
    setBusyId(mp.id)
    try {
      await controlManaged(mp, action)
      toast.success(t(action === "kill" ? "toast.killed" : "toast.restarted", { name: mp.name }))
    } catch (err) {
      toast.error(t("toast.failed", { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusyId(null)
      setConfirmKill(null)
    }
  }

  if (managed.length === 0) {
    return (
      <p
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="perf-managed-empty"
      >
        {t("empty")}
      </p>
    )
  }

  return (
    <div className="space-y-4" data-testid="perf-managed-processes">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={BoxesIcon}
          label={t("summary.managed")}
          value={formatCount(managed.length)}
          color="bg-chart-3/10 text-chart-3"
          data-testid="perf-managed-count"
        />
        <StatCard
          icon={PlayIcon}
          label={t("summary.running")}
          value={formatCount(totals.running)}
          color="bg-chart-4/10 text-chart-4"
          data-testid="perf-managed-running"
        />
        <StatCard
          icon={CpuIcon}
          label={t("summary.totalCpu")}
          value={formatPercent(totals.cpu)}
          color="bg-chart-1/10 text-chart-1"
          data-testid="perf-managed-cpu"
        />
        <StatCard
          icon={MemoryStickIcon}
          label={t("summary.totalMemory")}
          value={formatBytes(totals.mem)}
          color="bg-chart-2/10 text-chart-2"
          data-testid="perf-managed-mem"
        />
      </div>

      {groups.map(({ subsystem, rows }) => (
        <section
          key={subsystem}
          className="space-y-2"
          data-testid={`perf-managed-group-${subsystem}`}
        >
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{t(`subsystems.${subsystem}`)}</h3>
            <Badge variant="secondary" className="tabular-nums">
              {rows.length}
            </Badge>
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{t("columns.pid")}</TableHead>
                  <TableHead className="text-right">{t("columns.cpu")}</TableHead>
                  <TableHead className="text-right">{t("columns.memory")}</TableHead>
                  <TableHead className="text-right">{t("columns.uptime")}</TableHead>
                  <TableHead className="text-right">{t("columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ mp, proc }) => (
                  <TableRow key={mp.id} data-testid={`perf-managed-row-${mp.id}`}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{mp.name}</span>
                        {mp.detail ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {mp.detail}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn("shrink-0", STATUS_BADGE[mp.status])}
                        data-testid={`perf-managed-status-${mp.id}`}
                      >
                        {t(`status.${mp.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {mp.pid ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {proc ? formatPercent(proc.cpuPct) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {proc ? formatBytes(proc.memBytes) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {proc ? formatDurationShort(proc.runSecs * 1000) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs"
                          disabled={!mp.canRestart || busyId === mp.id}
                          title={mp.canRestart ? undefined : t("actions.restartUnavailable")}
                          onClick={() => runAction(mp, "restart")}
                          data-testid={`perf-managed-restart-${mp.id}`}
                        >
                          <RotateCwIcon className="size-3.5" />
                          {t("actions.restart")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                          disabled={!mp.canKill || busyId === mp.id}
                          onClick={() => setConfirmKill(mp)}
                          data-testid={`perf-managed-kill-${mp.id}`}
                        >
                          <XIcon className="size-3.5" />
                          {t("actions.kill")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}

      <AlertDialog
        open={confirmKill !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmKill(null)
        }}
      >
        <AlertDialogContent data-testid="perf-managed-kill-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirm.description", { name: confirmKill?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="perf-managed-kill-confirm"
              onClick={() => {
                if (confirmKill) void runAction(confirmKill, "kill")
              }}
            >
              {t("confirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
