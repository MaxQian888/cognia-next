"use client"

/**
 * Settings → Network Proxy → Test. Exercises the *current* proxy
 * configuration against a user-supplied URL and reports status + latency.
 * Works only inside Tauri — the web build shows a "needs desktop" notice.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { invoke } from "@tauri-apps/api/core"
import { CheckCircle2Icon, AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { isTauri } from "@/lib/tauri"
import type { ProxyTestResult } from "@/types/network/proxy"

export function NetworkTestTab() {
  const t = useTranslations("settings.network")
  const [url, setUrl] = useState("https://api.anthropic.com/v1/messages")
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ProxyTestResult | null>(null)

  const run = async () => {
    if (!isTauri()) return
    setRunning(true)
    setResult(null)
    try {
      const r = await invoke<ProxyTestResult>("proxy_test", {
        input: { url, timeoutMs: 10000 },
      })
      setResult(r)
    } catch (e) {
      setResult({
        ok: false,
        latencyMs: 0,
        error: String(e),
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm">{t("test.urlLabel")}</Label>
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.anthropic.com"
            aria-label={t("test.urlLabel")}
          />
          <Button onClick={run} disabled={running || !url.trim()}>
            {running ? t("test.running") : t("test.run")}
          </Button>
        </div>
      </div>

      {!isTauri() && <p className="text-xs text-muted-foreground">{t("test.webUnsupported")}</p>}

      {result && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2">
              {result.ok ? (
                <CheckCircle2Icon className="size-4 text-primary" />
              ) : (
                <AlertTriangleIcon className="size-4 text-destructive" />
              )}
              <span className="text-sm font-medium">
                {result.ok ? t("test.success") : t("test.failure")}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {result.status !== undefined && (
                <div>
                  <span className="text-muted-foreground">{t("test.statusLabel")}: </span>
                  <span className="font-mono">{result.status}</span>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">{t("test.latencyMs")}: </span>
                <span className="font-mono">{result.latencyMs} ms</span>
              </div>
              {result.proxyUrl && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">{t("test.proxyUrl")}: </span>
                  <span className="font-mono break-all">{result.proxyUrl}</span>
                </div>
              )}
              {!result.proxyUrl && (
                <div className="col-span-2 text-muted-foreground">{t("test.directConnection")}</div>
              )}
              {result.error && (
                <div className="col-span-2 text-destructive break-all">
                  <span>{result.error}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
