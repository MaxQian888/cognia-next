"use client"

/**
 * Settings → External Bridge → Audit log.
 *
 * `listMcpAuditLog` has always accepted `{ tool, deniedOnly, limit }`; the UI
 * only ever passed `{ limit: 50 }`, so the filtering was implemented and
 * unreachable. Both filters are wired here, alongside a row-count control —
 * "newest 50" was not a limit anyone chose, just the one the call site
 * hard-coded.
 *
 * A denial's `reason` was previously only in a `title` attribute: invisible on
 * touch, to screen readers, and to anyone who did not think to hover the exact
 * cell. It is now an expandable detail row.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionCollapse, MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsCard } from "@/components/settings/common/settings-section"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { clearMcpAuditLog, listMcpAuditLog } from "@/lib/db/mcp-audit-log"

type AuditRow = Awaited<ReturnType<typeof listMcpAuditLog>>[number]

const ROW_LIMITS = ["50", "100", "250"] as const

export function BridgeAuditPanel() {
  const t = useTranslations("settings.externalBridge")
  const [confirming, setConfirming] = useState(false)
  const [tool, setTool] = useState("")
  const [deniedOnly, setDeniedOnly] = useState(false)
  const [limit, setLimit] = useState<(typeof ROW_LIMITS)[number]>("50")
  const [expanded, setExpanded] = useState<number | string | null>(null)

  const rows =
    useLiveQuery(() => {
      const trimmed = tool.trim()
      return listMcpAuditLog({
        limit: Number.parseInt(limit, 10),
        ...(trimmed ? { tool: trimmed } : {}),
        ...(deniedOnly ? { deniedOnly: true } : {}),
      })
    }, [tool, deniedOnly, limit]) ?? []

  // "Arrived while you were watching" — derived from each row's own timestamp
  // rather than by diffing renders, so switching filters (which re-renders the
  // whole table) animates nothing and opening the panel does not slide the
  // whole backlog in at once.
  const [openedAt] = useState(() => Date.now())

  const onClear = useCallback(async () => {
    setConfirming(false)
    try {
      await clearMcpAuditLog()
      toast.success(t("audit.toastCleared"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [t])

  return (
    <div className="space-y-4">
      <SettingsCard
        title={t("audit.title")}
        description={t("audit.description")}
        headerAction={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(true)}
            disabled={rows.length === 0}
            aria-label={t("audit.clearAria")}
          >
            {t("audit.clear")}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={tool}
            placeholder={t("audit.filterToolPlaceholder")}
            aria-label={t("audit.tool")}
            className="h-8 w-44 text-xs"
            onChange={(e) => setTool(e.target.value)}
          />
          <Button
            size="sm"
            variant={deniedOnly ? "default" : "outline"}
            aria-pressed={deniedOnly}
            onClick={() => setDeniedOnly((v) => !v)}
            data-testid="bridge-audit-denied-only"
          >
            {t("audit.deniedOnly")}
          </Button>
          <Select value={limit} onValueChange={(v) => setLimit(v as (typeof ROW_LIMITS)[number])}>
            <SelectTrigger className="h-8 w-28 text-xs" aria-label={t("audit.rowLimit")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROW_LIMITS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t("audit.rowLimitValue", { count: value })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("audit.empty")}</p>
        ) : (
          <div className="max-h-[420px] overflow-x-auto overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead className="w-[140px] whitespace-nowrap">{t("audit.time")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("audit.tool")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("audit.scope")}</TableHead>
                  <TableHead className="w-[80px] whitespace-nowrap">{t("audit.status")}</TableHead>
                  <TableHead className="w-[80px] whitespace-nowrap text-right">
                    {t("audit.latency")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <AuditRowView
                    key={row.id}
                    row={row}
                    isFresh={row.ts > openedAt}
                    isExpanded={expanded === row.id}
                    onToggle={() =>
                      setExpanded((cur) => (cur === row.id ? null : (row.id ?? null)))
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsCard>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("audit.clearConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("audit.clearConfirmDesc", { count: rows.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("audit.clearCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onClear()}>
              {t("audit.clearConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AuditRowView({
  row,
  isFresh,
  isExpanded,
  onToggle,
}: {
  row: AuditRow
  isFresh: boolean
  isExpanded: boolean
  onToggle: () => void
}) {
  const t = useTranslations("settings.externalBridge")
  return (
    <>
      <TableRow>
        <TableCell className="py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={t("audit.detailAria", { tool: row.tool })}
            className="size-5 rounded-sm text-muted-foreground hover:bg-muted"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")}
              aria-hidden
            />
          </Button>
        </TableCell>
        <TableCell className="font-mono text-xs">
          {/* Only genuinely new rows animate — a filter change re-renders the
              whole table and animating every row there reads as noise. */}
          <MotionReveal disabled={!isFresh}>
            <span>{new Date(row.ts).toLocaleTimeString()}</span>
          </MotionReveal>
        </TableCell>
        <TableCell className="font-mono text-xs">{row.tool}</TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">{row.scope}</TableCell>
        <TableCell>
          {row.allowed ? (
            <span className="text-emerald-500">{t("audit.statusOk")}</span>
          ) : (
            <span className="text-amber-500">{t("audit.statusDeny")}</span>
          )}
        </TableCell>
        <TableCell className="text-right font-mono text-xs">
          {t("audit.latencyMs", { ms: row.latencyMs })}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={6} className="p-0">
          <MotionCollapse open={isExpanded}>
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 bg-muted/40 px-3 py-2 text-[11px]"
              data-testid={`bridge-audit-detail-${row.id}`}
            >
              <dt className="text-muted-foreground">{t("audit.scope")}</dt>
              <dd className="truncate font-mono">{row.scope}</dd>
              <dt className="text-muted-foreground">{t("audit.time")}</dt>
              <dd>{new Date(row.ts).toLocaleString()}</dd>
              {row.reason ? (
                <>
                  <dt className="text-muted-foreground">{t("audit.reason")}</dt>
                  <dd className="whitespace-pre-wrap break-all text-amber-600 dark:text-amber-400">
                    {row.reason}
                  </dd>
                </>
              ) : null}
            </dl>
          </MotionCollapse>
        </TableCell>
      </TableRow>
    </>
  )
}
