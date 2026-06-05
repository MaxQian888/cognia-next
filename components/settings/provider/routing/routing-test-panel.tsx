"use client"

// "What would the next send pick?" — pure, synchronous preview through the
// SAME engine + live telemetry stores the chat send path uses.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FlaskConical } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { buildRoutingEngine } from "@/lib/ai/routing/build-preview-engine"
import { FallbackChainView } from "./fallback-chain-view"
import type { RoutingResult } from "@/lib/ai/routing/provider-routing-engine"

export function RoutingTestPanel() {
  const t = useTranslations("providers.routingView")
  const settings = useSettingsStore((s) => s.settings)
  const [alias, setAlias] = useState("")
  const [result, setResult] = useState<RoutingResult | null | "none">("none")

  const runPreview = () => {
    if (!alias.trim() || !settings) return
    const engine = buildRoutingEngine(settings)
    setResult(engine.selectProvider({ model: alias.trim() }))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={alias}
          placeholder={t("testAliasPlaceholder")}
          aria-label={t("testAliasPlaceholder")}
          className="h-8 font-mono text-xs"
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runPreview()
          }}
        />
        <Button size="sm" className="h-8 shrink-0 text-xs" onClick={runPreview}>
          <FlaskConical className="mr-1 h-3 w-3" />
          {t("runPreview")}
        </Button>
      </div>

      {result !== "none" ? (
        result === null || !result.fromAlias ? (
          <p className="text-xs text-muted-foreground" data-testid="preview-no-match">
            {t("noMatch")}
          </p>
        ) : (
          <div
            className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5"
            data-testid="preview-result"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("resolvedTo")}</span>
              <Badge className="font-mono text-[10px]">
                {result.providerId}:{result.modelId}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {t(`strategy.${result.strategy}`)}
              </Badge>
            </div>
            {result.fallbackEntries.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground">{t("fallbackChain")}</p>
                <FallbackChainView
                  entries={[
                    { providerId: result.providerId, modelId: result.modelId },
                    ...result.fallbackEntries,
                  ]}
                />
              </div>
            ) : null}
            <p className="text-[10px] text-muted-foreground">{result.reason}</p>
          </div>
        )
      ) : null}
    </div>
  )
}

export default RoutingTestPanel
