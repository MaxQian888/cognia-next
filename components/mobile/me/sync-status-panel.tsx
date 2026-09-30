"use client"

/**
 * Full-page sync status for `/me/sync`.
 *
 * Reads the same per-table snapshot `<ConnectionDiagnosticsSheet>` shows,
 * but leads with a verdict: one summary block (overall state, how many
 * tables are current, when anything last synced, the one "Sync all"
 * button), then the transport tier, then the tables. Rows that failed are
 * pulled out into their own "Needs attention" group so the thing to act on
 * is the first list on the screen; the rest follow, never-synced before
 * synced, newest first. Ordering and the verdict come from
 * `lib/sync/sync-status-summary.ts` and are pinned there.
 *
 * Live data: `snapshotSyncStates()` is in-memory state managed by the
 * companion sync orchestrator. The orchestrator does not (yet) expose a
 * subscription API, so we re-read it on a slow tick to keep the relative
 * "lastSyncAt" stamp fresh, and refresh on demand right after a sync the
 * panel itself triggers so feedback is immediate (not up to a tick late).
 */

import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CloudOffIcon,
  LinkIcon,
  RefreshCwIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Surface } from "@/components/surface/surface"
import { MeSection } from "./me-section"
import { TransportTierIndicator } from "./transport-tier-indicator"
import { humanizeKey } from "@/lib/plugin/convert/secrets"
import { runSyncDown, snapshotSyncStates } from "@/lib/sync/companion-sync"
import type { SyncOutcome } from "@/lib/sync/types"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import {
  summarizeSyncSnapshot,
  type SyncOverallStatus,
  type SyncRowStatus,
  type SyncRowSummary,
} from "@/lib/sync/sync-status-summary"
import { cn } from "@/lib/utils"
import { formatRelative } from "@cognia/time"

type Snapshot = ReturnType<typeof snapshotSyncStates>

function useSyncSnapshot(intervalMs = 15_000): { snapshot: Snapshot; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => snapshotSyncStates())
  const refresh = useCallback(() => setSnapshot(snapshotSyncStates()), [])
  useEffect(() => {
    // Only the relative-time labels go stale between syncs, so a slow tick
    // is plenty — the prior 1Hz interval re-rendered the whole panel 60×/min
    // for no real freshness gain. Sync-triggered updates use `refresh()`.
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, refresh])
  return { snapshot, refresh }
}

/**
 * Emitted by `notifyCompanionConfigChanged` (lib/tauri/transport-companion) on
 * every pair, unpair and target switch.
 */
const COMPANION_CONFIG_EVENT = "cognia:companion-config-changed"

function subscribeCompanionConfig(onChange: () => void): () => void {
  window.addEventListener(COMPANION_CONFIG_EVENT, onChange)
  return () => window.removeEventListener(COMPANION_CONFIG_EVENT, onChange)
}

/**
 * Whether this device has a host to pull from. Sync mirrors a paired host, so
 * with none there is nothing any row could do: the panel says so and offers
 * the pairing flow instead of 48 "never synced" rows with live retry buttons.
 */
function useHasSyncHost(): boolean {
  return useSyncExternalStore(
    subscribeCompanionConfig,
    () => loadCompanionConfig() !== null,
    () => false
  )
}

type OverallKey = SyncOverallStatus | "noHost"

const OVERALL_VISUAL: Record<
  OverallKey,
  { icon: LucideIcon; iconClass: string; tileClass: string }
> = {
  healthy: {
    icon: CheckCircle2Icon,
    iconClass: "text-emerald-600 dark:text-emerald-400",
    tileClass: "bg-emerald-500/15",
  },
  failing: {
    icon: AlertTriangleIcon,
    iconClass: "text-destructive",
    tileClass: "bg-destructive/15",
  },
  partial: {
    icon: CircleDashedIcon,
    iconClass: "text-amber-600 dark:text-amber-400",
    tileClass: "bg-amber-500/15",
  },
  never: {
    icon: CloudOffIcon,
    iconClass: "text-muted-foreground",
    tileClass: "bg-muted",
  },
  empty: {
    icon: CloudOffIcon,
    iconClass: "text-muted-foreground",
    tileClass: "bg-muted",
  },
  noHost: {
    icon: CloudOffIcon,
    iconClass: "text-muted-foreground",
    tileClass: "bg-muted",
  },
}

const ROW_VISUAL: Record<SyncRowStatus, { icon: LucideIcon; className: string }> = {
  synced: { icon: CheckCircle2Icon, className: "text-emerald-600 dark:text-emerald-400" },
  never: { icon: CircleDashedIcon, className: "text-muted-foreground" },
  error: { icon: XCircleIcon, className: "text-destructive" },
}

export interface SyncStatusPanelProps {
  /** Override the snapshot reader (tests). */
  reader?: () => Snapshot
  /** Override the sync trigger (tests). */
  trigger?: (only?: readonly (keyof Snapshot)[]) => Promise<readonly SyncOutcome[]>
  /** Override whether a host is paired (tests). */
  hasHost?: boolean
}

export function SyncStatusPanel({ reader, trigger, hasHost }: SyncStatusPanelProps = {}) {
  const t = useTranslations("mobile.me.sync")
  const router = useRouter()
  const { snapshot: liveSnapshot, refresh } = useSyncSnapshot()
  const snapshot = reader ? reader() : liveSnapshot
  const liveHasHost = useHasSyncHost()
  const paired = hasHost ?? liveHasHost
  const [busy, setBusy] = useState<keyof Snapshot | "all" | null>(null)

  const onSync = useCallback(
    async (only?: keyof Snapshot) => {
      const target = only ?? "all"
      setBusy(target)
      try {
        const runner =
          trigger ?? ((scope?: readonly (keyof Snapshot)[]) => runSyncDown({ only: scope }))
        const outcomes = await runner(only ? [only] : undefined)
        // Pull the freshest orchestrator state immediately rather than
        // waiting for the next slow tick.
        refresh()
        // The orchestrator never rejects for a table that failed: it resolves
        // with one outcome per table. The toast has to read them, or a retry
        // that failed again announces "Synced" over a row that is still red.
        const noHost = outcomes.some((o) => !o.ok && o.failure.reason === "no_host")
        const failures = outcomes.flatMap((o) =>
          o.ok || o.failure.reason === "no_host" ? [] : [o.failure]
        )
        if (noHost) {
          toast.error(t("toastNoHost"))
        } else if (failures.length > 0) {
          toast.error(
            only
              ? t("toastTableFailed", { table: humanizeKey(only), reason: failures[0].message })
              : t("toastSomeFailed", { failed: failures.length, total: outcomes.length })
          )
        } else {
          toast.success(
            only ? t("toastTableSynced", { table: humanizeKey(only) }) : t("toastAllSynced")
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("toastError", { reason: message }))
      } finally {
        setBusy(null)
      }
    },
    [t, trigger, refresh]
  )

  const summary = summarizeSyncSnapshot(snapshot)
  const overallKey: OverallKey = paired ? summary.overall : "noHost"
  const overall = OVERALL_VISUAL[overallKey]
  const OverallIcon = overall.icon
  const hintArgs = {
    synced: summary.syncedCount,
    total: summary.total,
    time: summary.lastSyncAt ? formatRelative(summary.lastSyncAt) : "",
  }

  const renderRow = (row: SyncRowSummary, idx: number) => {
    const visual = ROW_VISUAL[row.status]
    const RowIcon = visual.icon
    const table = row.table as keyof Snapshot
    return (
      <Fragment key={row.table}>
        {idx > 0 ? <ItemSeparator /> : null}
        <Item
          size="sm"
          className="flex-nowrap px-3 py-2"
          data-testid={`sync-row-${row.table}`}
          data-sync-status={row.status}
        >
          <ItemMedia className="self-center">
            <RowIcon className={cn("size-4", visual.className)} aria-hidden="true" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            {/* The protocol table name, split into words. Rendered raw it
                read "ConversationOverrides" and "AgentTaskAttempts": the
                identifier is the useful fact on a diagnostics screen, but
                the camel hump is not. */}
            <ItemTitle className="text-sm">{humanizeKey(row.table)}</ItemTitle>
            {row.lastError ? (
              <ItemDescription className="text-xs text-destructive">{row.lastError}</ItemDescription>
            ) : (
              <ItemDescription className="text-xs">
                {/* "Last synced {time}" with a "Never synced yet" time
                    composed into "Last synced Never synced yet". The two
                    are alternatives, not a template and its value. */}
                {row.lastSyncAt
                  ? t("lastSynced", { time: formatRelative(row.lastSyncAt) })
                  : t("neverSynced")}
              </ItemDescription>
            )}
          </ItemContent>
          <ItemActions className="shrink-0">
            <Button
              type="button"
              size="sm"
              variant={row.status === "error" ? "outline" : "ghost"}
              className={row.status === "error" ? "h-7 px-2 text-xs" : "size-8 p-0"}
              disabled={busy !== null || !paired}
              onClick={() => void onSync(table)}
              aria-label={t("syncRowAria", { table: row.table })}
              data-testid={`sync-row-retry-${row.table}`}
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={cn("size-3.5", busy === table && "animate-spin")}
              />
              {row.status === "error" ? t("retry") : null}
            </Button>
          </ItemActions>
        </Item>
      </Fragment>
    )
  }

  return (
    <div className="@container flex flex-col gap-5" data-testid="sync-status-panel">
      <Surface
        layer="raised"
        radius="panel"
        className="flex flex-col gap-4 border px-4 py-4 @xl:flex-row @xl:items-center"
        role="status"
        aria-live="polite"
        data-testid="sync-status-summary"
        data-sync-overall={overallKey}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full",
              overall.tileClass
            )}
            aria-hidden="true"
          >
            <OverallIcon className={cn("size-5", overall.iconClass)} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight" data-testid="sync-status-headline">
              {t(`overall.${overallKey}`, { count: summary.failingCount })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(`overallHint.${overallKey}`, hintArgs)}
            </p>
          </div>
        </div>
        {paired ? (
          <Button
            type="button"
            size="sm"
            variant={summary.overall === "healthy" ? "outline" : "default"}
            className="w-full @xl:w-auto"
            disabled={busy !== null || summary.total === 0}
            onClick={() => void onSync()}
            data-testid="sync-status-run-all"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-3.5", busy === "all" && "animate-spin")}
            />
            {t("syncAll")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="w-full @xl:w-auto"
            onClick={() => router.push("/pair")}
            data-testid="sync-status-pair"
          >
            <LinkIcon aria-hidden="true" className="size-3.5" />
            {t("pairHost")}
          </Button>
        )}
      </Surface>

      <TransportTierIndicator />

      {summary.failing.length > 0 ? (
        <MeSection
          title={t("attentionTitle")}
          description={t("attentionDescription")}
          testid="sync-attention"
        >
          {summary.failing.map(renderRow)}
        </MeSection>
      ) : null}

      {summary.rest.length > 0 ? (
        <MeSection
          title={t("tablesTitle")}
          description={t("tablesDescription", {
            synced: summary.syncedCount,
            total: summary.total,
          })}
          testid="sync-tables"
        >
          {summary.rest.map(renderRow)}
        </MeSection>
      ) : null}
    </div>
  )
}
