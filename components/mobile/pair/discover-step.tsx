"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, RefreshCwIcon, SearchXIcon, ScanLineIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { scanLan, type DiscoveredServer } from "@/lib/connectivity/lan-scanner"

import { ScanRadar } from "./scan-radar"
import { ServerCard } from "./server-card"

export interface DiscoverStepProps {
  /** Pre-populate the list with previously paired baseUrls. */
  history?: DiscoveredServer[]
  /** Called when a user taps a discovered server. */
  onSelect: (server: DiscoveredServer) => void
  /** Called when the user opts out of auto-discovery. */
  onSkip: () => void
  /** Test seam — replaces the full scan with a stub. */
  scan?: typeof scanLan
}

type ScanState = "scanning" | "idle"

const SCAN_WINDOW_MS = 5_000
const EMPTY_HISTORY: readonly DiscoveredServer[] = []

export function DiscoverStep({ history, onSelect, onSkip, scan = scanLan }: DiscoverStepProps) {
  const t = useTranslations("mobile.pair.discover")
  const tPerm = useTranslations("mobile.pair.permissions")
  // Snapshot history at mount — props default `[]` would otherwise create
  // a new array per render and retrigger the auto-scan effect forever.
  const [stableHistory] = useState<readonly DiscoveredServer[]>(history ?? EMPTY_HISTORY)
  const [servers, setServers] = useState<DiscoveredServer[]>(() =>
    stableHistory.map((h) => ({ ...h, source: "history" as const }))
  )
  const [scanState, setScanState] = useState<ScanState>("scanning")
  const [permissionDenied, setPermissionDenied] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Pure side-effect runner; does NOT touch local state synchronously
  // (the linter rejects setState calls inside an effect body, and the
  // initial scanState is already "scanning" so we don't need to set it).
  const runScan = useCallback(() => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    void scan({
      signal: controller.signal,
      mdnsWindowMs: SCAN_WINDOW_MS,
      history: stableHistory as DiscoveredServer[],
      onFound: (svc) =>
        setServers((prev) => {
          const idx = prev.findIndex((s) => s.id === svc.id)
          if (idx < 0) return [...prev, svc]
          const existing = prev[idx]
          if (rank(existing.source) >= rank(svc.source)) return prev
          const next = [...prev]
          next[idx] = svc
          return next
        }),
    })
      .catch((err) => {
        if (isPermissionError(err)) setPermissionDenied(true)
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setScanState("idle")
      })
  }, [scan, stableHistory])

  // Click handler: explicit user-initiated rescan. Resets transient state
  // synchronously, then kicks off the side-effect.
  const onRescan = useCallback(() => {
    setScanState("scanning")
    setPermissionDenied(false)
    runScan()
  }, [runScan])

  useEffect(() => {
    runScan()
    return () => {
      abortRef.current?.abort()
    }
  }, [runScan])

  const sortedServers = useMemo(() => sortServers(servers), [servers])
  const foundCount = sortedServers.length
  const showEmpty = scanState === "idle" && foundCount === 0
  const reduce = useReducedMotion()

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={t("title")}
      data-testid="pair-discover-step"
    >
      <header className="flex flex-col items-center gap-2 text-center">
        <ScanRadar active={scanState === "scanning"} />
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="max-w-sm text-balance text-sm text-muted-foreground">
          {scanState === "scanning" ? t("scanning") : t("subtitle")}
        </p>
        <span
          aria-live="polite"
          className="text-[11px] uppercase tracking-wide text-muted-foreground"
        >
          {scanState === "scanning" ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="size-3" />
              {t("foundCount", { count: foundCount })}
            </span>
          ) : (
            t("foundCount", { count: foundCount })
          )}
        </span>
      </header>

      {permissionDenied ? (
        <Alert variant="destructive" data-testid="pair-discover-permission">
          <AlertTitle>{tPerm("localNetwork.title")}</AlertTitle>
          <AlertDescription>{tPerm("localNetwork.description")}</AlertDescription>
        </Alert>
      ) : null}

      {sortedServers.length > 0 ? (
        <motion.ul
          className="flex flex-col gap-2"
          role="list"
          initial={reduce ? false : "initial"}
          animate="animate"
          variants={STAGGER_CONTAINER}
        >
          {sortedServers.map((server) => (
            <motion.li key={server.id} variants={STAGGER_CHILD}>
              <ServerCard server={server} onSelect={onSelect} />
            </motion.li>
          ))}
        </motion.ul>
      ) : null}

      {showEmpty ? (
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center"
          data-testid="pair-discover-empty"
        >
          <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <SearchXIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">{t("emptyTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("emptyDescription")}</p>
          </div>
        </div>
      ) : null}

      <div className={cn("flex flex-col gap-2", showEmpty ? "" : "border-t pt-3")}>
        <Button
          type="button"
          variant={showEmpty ? "default" : "outline"}
          size="lg"
          className="touch-target w-full"
          onClick={onSkip}
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
          onClick={onRescan}
          disabled={scanState === "scanning"}
          data-testid="pair-discover-rescan"
        >
          <RefreshCwIcon
            className={cn("size-4", scanState === "scanning" && "animate-spin")}
            aria-hidden="true"
          />
          {scanState === "scanning" ? t("scanning") : t("rescanCta")}
        </Button>
      </div>
    </section>
  )
}

function rank(source: DiscoveredServer["source"]): number {
  if (source === "mdns") return 3
  if (source === "probe") return 2
  return 1
}

/**
 * Sort by source priority (mDNS first, probe second, history last) then
 * by latency ascending so the closest server lands at the top.
 */
function sortServers(items: DiscoveredServer[]): DiscoveredServer[] {
  return [...items].sort((a, b) => {
    const r = rank(b.source) - rank(a.source)
    if (r !== 0) return r
    const al = a.latencyMs ?? Number.POSITIVE_INFINITY
    const bl = b.latencyMs ?? Number.POSITIVE_INFINITY
    return al - bl
  })
}

function isPermissionError(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /permission|denied|not allowed/i.test(msg)
}
