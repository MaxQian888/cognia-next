"use client"

/**
 * Settings → Network Proxy → Detection. One-click probe of common local
 * proxy ports (Clash, V2Ray, Shadowsocks, generic HTTP/SOCKS) plus a Clash
 * controller API check that surfaces the version string when present.
 *
 * Picking a candidate writes the corresponding host/port/protocol back into
 * `networkProxy` (mode flips to `auto`) and pushes the new config to Rust.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { invoke } from "@tauri-apps/api/core"
import { CheckCircle2Icon, AlertTriangleIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

import { useSettingsStore } from "@/stores/settings"
import { applyProxyToRust } from "@/stores/network-proxy"
import { isTauri } from "@/lib/tauri"
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type NetworkProxySettings,
  type ProxyCandidate,
  type ProxyProtocol,
} from "@/types/network/proxy"

function candidateToProtocol(kind: ProxyCandidate["kind"]): ProxyProtocol {
  if (kind === "socks5") return "socks5"
  return "http" // both "http" and "clash" map to HTTP
}

/**
 * Build the next `networkProxy` payload from a detection candidate. Pulled
 * out of the component body so the React Compiler doesn't flag the
 * `Date.now()` call inside the event handler as render-time impurity.
 */
function buildAppliedConfig(
  current: NetworkProxySettings,
  candidate: ProxyCandidate
): NetworkProxySettings {
  return {
    ...current,
    mode: "auto",
    protocol: candidateToProtocol(candidate.kind),
    host: candidate.host,
    port: candidate.port,
    lastDetectedAt: Date.now(),
  }
}

export function NetworkDetectionTab() {
  const t = useTranslations("settings.network")
  const settings = useSettingsStore((s) => s.settings?.networkProxy)
  const save = useSettingsStore((s) => s.save)

  const [candidates, setCandidates] = useState<ProxyCandidate[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cfg: NetworkProxySettings = settings ?? DEFAULT_NETWORK_PROXY_SETTINGS

  const runDetect = async () => {
    if (!isTauri()) {
      setError(t("detection.webUnsupported"))
      return
    }
    setRunning(true)
    setError(null)
    try {
      const result = await invoke<ProxyCandidate[]>("proxy_detect")
      setCandidates(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const apply = async (candidate: ProxyCandidate) => {
    const next = buildAppliedConfig(cfg, candidate)
    await save({ networkProxy: next })
    void applyProxyToRust(next)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{t("detection.heading")}</p>
          <p className="text-xs text-muted-foreground">{t("detection.subheading")}</p>
        </div>
        <Button onClick={runDetect} disabled={running} aria-label={t("detection.button")}>
          <RefreshCwIcon className={running ? "size-4 animate-spin" : "size-4"} />
          {t("detection.button")}
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertTriangleIcon className="size-4" />
            <span>{error}</span>
          </CardContent>
        </Card>
      )}

      {running && (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {!running && candidates !== null && candidates.length === 0 && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            {t("detection.empty")}
          </CardContent>
        </Card>
      )}

      {!running && candidates && candidates.length > 0 && (
        <div className="space-y-2">
          {candidates.map((candidate, idx) => {
            const isCurrent =
              cfg.host === candidate.host && cfg.port === candidate.port && cfg.mode !== "off"
            return (
              <Card key={`${candidate.host}:${candidate.port}:${idx}`}>
                <CardContent className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">{candidate.kind.toUpperCase()}</Badge>
                    {candidate.clientName && (
                      <Badge variant="secondary">{candidate.clientName}</Badge>
                    )}
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{candidate.label}</span>
                      {candidate.source && (
                        <span className="text-xs text-muted-foreground">
                          {t(`detection.source.${candidate.source}`)}
                          {candidate.controllerSecured && ` · ${t("detection.controllerSecured")}`}
                        </span>
                      )}
                      {candidate.version && (
                        <span className="text-xs text-muted-foreground">v{candidate.version}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isCurrent && (
                      <span
                        className="flex items-center gap-1 text-xs text-primary"
                        aria-label={t("detection.currentBadge")}
                      >
                        <CheckCircle2Icon className="size-4" />
                        {t("detection.currentBadge")}
                      </span>
                    )}
                    <Button size="sm" onClick={() => apply(candidate)} disabled={isCurrent}>
                      {t("detection.apply")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
