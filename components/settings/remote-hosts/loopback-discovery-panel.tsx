"use client"

/**
 * The browser/mobile counterpart of `LanDiscoveryPanel`.
 *
 * mDNS needs a multicast socket, which a tab does not have, so the desktop's
 * `_cognia._tcp` sweep is simply unavailable off Tauri. What a tab *can* do is
 * probe its own machine's loopback browser-access listener, and
 * `lib/connectivity/loopback-discovery.ts` already implements exactly that,
 * including the `no-cors` retry that separates "a host refused this origin"
 * from "nothing is listening". It was written for this case and until now had
 * only two callers (the LAN scanner and `/pair`).
 *
 * The three outcomes are kept distinct on purpose. `blocked` is the one that
 * matters: it names the exact origin to allowlist on the other machine, which
 * is the difference between an actionable message and "no hosts found".
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { RadarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  discoverLoopbackHost,
  type LoopbackProbeOutcome,
} from "@/lib/connectivity/loopback-discovery"

export interface LoopbackDiscoveryPanelProps {
  /** Called with the discovered base URL so the form can pre-fill it. */
  onUseAddress?: (baseUrl: string) => void
  /** Test seam. Defaults to the real loopback probe. */
  discover?: typeof discoverLoopbackHost
}

export function LoopbackDiscoveryPanel({
  onUseAddress,
  discover = discoverLoopbackHost,
}: LoopbackDiscoveryPanelProps) {
  const t = useTranslations("settings.remoteHosts.add.loopback")
  const [outcome, setOutcome] = useState<LoopbackProbeOutcome | null>(null)
  const [probing, setProbing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // A probe that outlives the panel would set state on an unmounted tree and,
  // worse, keep two loopback fetches racing if the user reopens the sheet.
  useEffect(() => () => abortRef.current?.abort(), [])

  const onProbe = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setProbing(true)
    try {
      setOutcome(await discover({ signal: controller.signal }))
    } finally {
      if (!controller.signal.aborted) setProbing(false)
    }
  }, [discover])

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="loopback-discovery-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("title")}</span>
        <Button variant="outline" size="sm" onClick={onProbe} disabled={probing}>
          <RadarIcon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {probing ? t("probing") : t("probe")}
        </Button>
      </div>

      {outcome?.kind === "found" ? (
        <div className="space-y-1.5" data-testid="loopback-found">
          <p className="text-xs text-success">
            {t("found", { version: outcome.health.version, url: outcome.baseUrl })}
          </p>
          <p className="text-xs text-muted-foreground">{t("foundHint")}</p>
          {onUseAddress ? (
            <Button variant="secondary" size="sm" onClick={() => onUseAddress(outcome.baseUrl)}>
              {t("useAddress")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Something answered, but this tab's origin is not on the host's
          allowlist. Naming the origin verbatim is the whole point: it is the
          exact string the user has to paste on the other machine. */}
      {outcome?.kind === "blocked" ? (
        <div className="space-y-0.5" data-testid="loopback-blocked">
          <p className="text-xs text-warning">{t("blocked", { url: outcome.baseUrl })}</p>
          <p className="text-xs text-muted-foreground">
            {t("blockedHint", { origin: outcome.origin })}
          </p>
        </div>
      ) : null}

      {outcome?.kind === "absent" ? (
        <div className="space-y-0.5" data-testid="loopback-absent">
          <p className="text-xs text-muted-foreground">{t("absent")}</p>
          <p className="text-xs text-muted-foreground">{t("absentHint")}</p>
        </div>
      ) : null}
    </div>
  )
}
