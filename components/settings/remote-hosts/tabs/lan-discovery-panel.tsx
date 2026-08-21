"use client"

/**
 * Settings → Remote hosts → Add host — the LAN discovery panel (ADR-0082).
 *
 * The desktop has advertised `_cognia._tcp` since Wave 1.5 but never browsed
 * for it, so adding a remote host meant typing an address for a machine that
 * was announcing its own the whole time. This panel sweeps the LAN and does
 * two things with the result:
 *
 * 1. **Lists what is out there** — so the user can see a host exists (and at
 *    what version) before hunting for an invitation on it.
 * 2. **Cross-checks the pasted invitation** by TLS SPKI fingerprint. An
 *    invitation generated before a DHCP move carries a stale address, and
 *    pairing with it fails with a bare connection error that names nothing
 *    actionable. Matching on the fingerprint — never the address, which is
 *    exactly the field that goes stale — lets us offer the live one.
 *
 * Rewriting the address is safe precisely because the fingerprint matched: the
 * pin the client will verify against is unchanged, so this repoints the
 * invitation at the same host, not a different one.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { RadarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  browseLanHosts,
  classifyPayloadReachability,
  type BrowsedHost,
} from "@/lib/connectivity/mdns-browse"
import { decodePairPayload, encodePairPayload } from "@/lib/qr/pair-payload"

export interface LanDiscoveryPanelProps {
  /** Current contents of the pair-payload field. */
  payload: string
  /** Called with a rewritten payload when the user takes the live address. */
  onUseAddress: (nextPayload: string) => void
  /** Test seam — defaults to the real mDNS sweep. */
  browse?: typeof browseLanHosts
}

export function LanDiscoveryPanel({
  payload,
  onUseAddress,
  browse = browseLanHosts,
}: LanDiscoveryPanelProps) {
  const t = useTranslations("settings.remoteHosts.add.discover")
  const [hosts, setHosts] = useState<BrowsedHost[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)

  const onScan = useCallback(async () => {
    setScanning(true)
    try {
      // 2.5 s: long enough for a host that is awake but slow to answer, short
      // enough that the form does not read as hung.
      setHosts(await browse({ timeoutMs: 2500 }))
      setScanned(true)
    } finally {
      setScanning(false)
    }
  }, [browse])

  /** The decoded invitation, or null while the field is empty/unparseable. */
  const decoded = useMemo(() => {
    if (!payload.trim()) return null
    const outcome = decodePairPayload(payload)
    return outcome.kind === "ok" ? outcome.payload : null
  }, [payload])

  const reachability = useMemo(() => classifyPayloadReachability(hosts, decoded), [hosts, decoded])

  const onUseLiveAddress = useCallback(() => {
    if (reachability.kind !== "address-differs" || !decoded) return
    onUseAddress(encodePairPayload({ ...decoded, baseUrl: reachability.liveBaseUrl }))
  }, [reachability, decoded, onUseAddress])

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="lan-discovery-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("title")}</span>
        <Button variant="outline" size="sm" onClick={onScan} disabled={scanning}>
          <RadarIcon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {scanning ? t("scanning") : t("scan")}
        </Button>
      </div>

      {hosts.length > 0 ? (
        <ul className="space-y-1">
          {hosts.map((host) => (
            <li
              key={host.fullname}
              className="flex items-center justify-between gap-2 rounded border bg-card px-2 py-1.5 text-xs"
              data-testid="lan-discovery-host"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{host.instanceName}</span>
                {host.baseUrl ? (
                  <span className="ml-1.5 text-muted-foreground">{host.baseUrl}</span>
                ) : null}
              </span>
              {host.appVersion ? (
                <span className="shrink-0 text-muted-foreground">
                  {t("version", { version: host.appVersion })}
                </span>
              ) : null}
              {host.isSelf ? (
                <Badge variant="secondary" className="shrink-0">
                  {t("self")}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      ) : scanned ? (
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
          <p className="text-xs text-muted-foreground">{t("emptyHint")}</p>
        </div>
      ) : null}

      {/* The cross-check only says something once a sweep has actually run —
          before that, "not advertising" would just mean "we never looked". */}
      {scanned && decoded ? (
        <ReachabilityNote
          reachability={reachability}
          claimedBaseUrl={decoded.baseUrl}
          onUseLiveAddress={onUseLiveAddress}
        />
      ) : null}
    </div>
  )
}

function ReachabilityNote({
  reachability,
  claimedBaseUrl,
  onUseLiveAddress,
}: {
  reachability: ReturnType<typeof classifyPayloadReachability>
  claimedBaseUrl: string
  onUseLiveAddress: () => void
}) {
  const t = useTranslations("settings.remoteHosts.add.discover")

  if (reachability.kind === "not-advertising") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="lan-discovery-not-advertising">
        {t("notAdvertising")}
      </p>
    )
  }

  if (reachability.kind === "match") {
    return (
      <p
        className="text-xs text-emerald-600 dark:text-emerald-400"
        data-testid="lan-discovery-match"
      >
        {t("matchLive", { url: reachability.host.baseUrl ?? claimedBaseUrl })}
      </p>
    )
  }

  return (
    <div className="space-y-1.5" data-testid="lan-discovery-stale">
      <p className="text-xs text-amber-600 dark:text-amber-500">
        {t("matchStale", { claimed: claimedBaseUrl, live: reachability.liveBaseUrl })}
      </p>
      <Button variant="secondary" size="sm" onClick={onUseLiveAddress}>
        {t("useAddress")}
      </Button>
    </div>
  )
}
