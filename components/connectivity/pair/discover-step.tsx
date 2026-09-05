"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, QrCodeIcon, RefreshCwIcon, ScanLineIcon, SearchXIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/mobile/empty-state"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { fetchHealthz } from "@/lib/connectivity/healthz"
import { impact, notify } from "@/lib/capacitor/haptics"
import {
  rankSource,
  scanLan,
  type DiscoveredServer,
  type PairedSummary,
} from "@/lib/connectivity/lan-scanner"
import { useLanScan } from "@/hooks/connectivity/use-lan-scan"

import { DiscoverHelp } from "./discover-help"
import { ScanRadar } from "./scan-radar"
import { ServerCard, type ServerCardStatus } from "./server-card"
import type { PairHostState } from "./pair-scene"

export interface DiscoverStepProps {
  /** Pre-populate the list with previously paired / recent servers. */
  history?: DiscoveredServer[]
  /** Currently-paired desktop(s) — ranked at the top, drive multi-port probe. */
  paired?: PairedSummary[]
  /** Called once a tapped server passes the pre-flight reachability check. */
  onSelect: (server: DiscoveredServer) => void
  /** Called when the user opts into manual entry. */
  onSkip: () => void
  /** Called when the user taps "Scan QR" — jumps to the pair step's scanner. */
  onScanShortcut?: () => void
  /**
   * Reports what the scan currently knows about the far end, so the shell's
   * scene can draw it. The step owns the scan, so it is the only thing that
   * can answer; deriving it a second time in the coordinator is how the
   * picture and the list end up disagreeing.
   */
  onHostStateChange?: (state: PairHostState) => void
  /** Test seam — replaces the full scan. */
  scan?: typeof scanLan
  /** Test seam — replaces the `/healthz` pre-flight probe. */
  probe?: typeof fetchHealthz
  /** How long the ✓ result lingers before advancing. Test seam (default 600). */
  precheckDelayMs?: number
}

const SCAN_WINDOW_MS = 5_000
const PRECHECK_TIMEOUT_MS = 800

interface Precheck {
  id: string
  status: ServerCardStatus
  label?: string
}

export function DiscoverStep({
  history,
  paired,
  onSelect,
  onSkip,
  onScanShortcut,
  onHostStateChange,
  scan = scanLan,
  probe = fetchHealthz,
  precheckDelayMs = 600,
}: DiscoverStepProps) {
  const t = useTranslations("mobile.pair.discover")
  const tPerm = useTranslations("mobile.pair.permissions")
  const reduce = useReducedMotion()

  const { servers, scanning, permissionDenied, rescan, loopbackBlocked } = useLanScan({
    history,
    paired,
    mdnsWindowMs: SCAN_WINDOW_MS,
    scan,
  })

  const [precheck, setPrecheck] = useState<Precheck | null>(null)
  // The linger timer that advances to the pair step after a ✓ precheck. Kept
  // in a ref so unmount (user backed out mid-linger) cancels the advance.
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) clearTimeout(advanceTimerRef.current)
    }
  }, [])

  const sorted = useMemo(() => sortServers(servers), [servers])
  const recent = useMemo(
    () => sorted.filter((s) => s.source === "paired" || s.source === "history"),
    [sorted]
  )
  const live = useMemo(
    // `loopback` belongs here too: a browser tab has no other way to find a
    // Host, so omitting it would discover one and then never show it.
    () =>
      sorted.filter((s) => s.source === "mdns" || s.source === "probe" || s.source === "loopback"),
    [sorted]
  )
  const foundCount = sorted.length
  const showEmpty = !scanning && foundCount === 0
  const checking = precheck?.status === "checking"

  // `blocked` outranks `reachable`: a Host that answered and refused us is a
  // more specific — and more actionable — fact than a list that happens to
  // have entries in it from history.
  const hostState: PairHostState = loopbackBlocked
    ? "blocked"
    : live.length > 0
      ? "reachable"
      : scanning
        ? "searching"
        : "absent"
  useEffect(() => {
    onHostStateChange?.(hostState)
  }, [hostState, onHostStateChange])

  // Pre-flight: probe `/healthz` before advancing so we never hand a dead
  // server to the pair step. Success enriches the picked server with the
  // reported version + fingerprint; failure surfaces inline and stays put.
  const onCardSelect = useCallback(
    async (server: DiscoveredServer) => {
      void impact("light")
      setPrecheck({ id: server.id, status: "checking" })
      const startedAt = Date.now()
      const hz = await probe(server.baseUrl, {
        signal: new AbortController().signal,
        timeoutMs: PRECHECK_TIMEOUT_MS,
      })
      if (!hz) {
        void notify("error")
        setPrecheck({ id: server.id, status: "error", label: t("precheckUnreachable") })
        return
      }
      const latencyMs = Date.now() - startedAt
      void notify("success")
      setPrecheck({
        id: server.id,
        status: "ok",
        label: t("precheckOk", { version: hz.version, ms: latencyMs }),
      })
      const enriched: DiscoveredServer = {
        ...server,
        fingerprint: server.fingerprint ?? hz.fingerprint,
        serverId: server.serverId ?? hz.serverId,
        serverVersion: server.serverVersion ?? hz.version,
        latencyMs: server.latencyMs ?? latencyMs,
      }
      if (precheckDelayMs <= 0) {
        onSelect(enriched)
        return
      }
      advanceTimerRef.current = setTimeout(() => onSelect(enriched), precheckDelayMs)
    },
    [probe, onSelect, precheckDelayMs, t]
  )

  const statusFor = (id: string): ServerCardStatus =>
    precheck?.id === id ? precheck.status : "idle"
  const labelFor = (id: string) => (precheck?.id === id ? precheck.label : undefined)

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={t("title")}
      data-testid="pair-discover-step"
    >
      <header className="flex flex-col items-center gap-2 text-center">
        <ScanRadar active={scanning} />
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="max-w-sm text-balance text-sm text-muted-foreground">
          {scanning ? t("scanning") : t("subtitle")}
        </p>
        <span
          aria-live="polite"
          className="text-[11px] uppercase tracking-wide text-muted-foreground"
        >
          {t("foundCount", { count: foundCount })}
        </span>
      </header>

      {permissionDenied ? (
        <Alert variant="destructive" data-testid="pair-discover-permission">
          <AlertTitle>{tPerm("localNetwork.title")}</AlertTitle>
          <AlertDescription>{tPerm("localNetwork.description")}</AlertDescription>
        </Alert>
      ) : null}

      {recent.length > 0 ? (
        <ServerGroup
          heading={t("recentTitle")}
          servers={recent}
          onSelect={onCardSelect}
          statusFor={statusFor}
          labelFor={labelFor}
          disabled={checking}
          reduce={reduce}
          testid="pair-discover-recent"
        />
      ) : null}

      {live.length > 0 ? (
        <ServerGroup
          heading={recent.length > 0 ? t("nearbyTitle") : undefined}
          servers={live}
          onSelect={onCardSelect}
          statusFor={statusFor}
          labelFor={labelFor}
          disabled={checking}
          reduce={reduce}
          testid="pair-discover-nearby"
        />
      ) : null}

      {/* A Host answered on loopback but refused this browser's origin. Shown
          above the empty state because it *contradicts* it: something is
          running here, it just will not talk to this tab yet. */}
      {loopbackBlocked ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
          data-testid="pair-discover-loopback-blocked"
        >
          <p className="font-medium">{t("loopbackBlockedTitle")}</p>
          <p className="mt-1 text-muted-foreground">
            {t("loopbackBlockedBody", { origin: loopbackBlocked.origin })}
          </p>
        </div>
      ) : null}

      {showEmpty && !loopbackBlocked ? (
        <EmptyState
          icon={SearchXIcon}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          className="py-8"
        />
      ) : null}

      <DiscoverHelp emphasised={showEmpty} />

      <div className="flex flex-col gap-2 border-t pt-3">
        {onScanShortcut ? (
          <Button
            type="button"
            size="lg"
            className="touch-target w-full"
            onClick={onScanShortcut}
            disabled={checking}
            data-testid="pair-discover-scan-qr"
          >
            <QrCodeIcon className="size-4" aria-hidden="true" />
            {t("scanQrCta")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="touch-target w-full"
          onClick={onSkip}
          disabled={checking}
          data-testid="pair-discover-skip"
        >
          <ScanLineIcon className="size-4" aria-hidden="true" />
          {t("skipToManual")}
          <ArrowRightIcon className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="touch-target w-full"
          onClick={rescan}
          disabled={scanning || checking}
          data-testid="pair-discover-rescan"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {scanning ? t("scanning") : t("rescanCta")}
        </Button>
      </div>
    </section>
  )
}

interface ServerGroupProps {
  heading?: string
  servers: DiscoveredServer[]
  onSelect: (server: DiscoveredServer) => void
  statusFor: (id: string) => ServerCardStatus
  labelFor: (id: string) => string | undefined
  disabled: boolean
  reduce: boolean | null
  testid: string
}

function ServerGroup({
  heading,
  servers,
  onSelect,
  statusFor,
  labelFor,
  disabled,
  reduce,
  testid,
}: ServerGroupProps) {
  return (
    <div className="flex flex-col gap-2" data-testid={testid}>
      {heading ? (
        <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {heading}
        </p>
      ) : null}
      <motion.ul
        className="flex flex-col gap-2"
        role="list"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {servers.map((server) => {
          const status = statusFor(server.id)
          return (
            <motion.li key={server.id} variants={STAGGER_CHILD}>
              <ServerCard
                server={server}
                onSelect={onSelect}
                status={status}
                statusLabel={labelFor(server.id)}
                disabled={disabled && status !== "checking"}
              />
            </motion.li>
          )
        })}
      </motion.ul>
    </div>
  )
}

/**
 * Sort by source priority (paired → mDNS → probe → history) then latency
 * ascending so the closest server lands at the top. Uses the canonical
 * `rankSource` from `lan-scanner`.
 */
function sortServers(items: DiscoveredServer[]): DiscoveredServer[] {
  return [...items].sort((a, b) => {
    const r = rankSource(b.source) - rankSource(a.source)
    if (r !== 0) return r
    const al = a.latencyMs ?? Number.POSITIVE_INFINITY
    const bl = b.latencyMs ?? Number.POSITIVE_INFINITY
    return al - bl
  })
}
