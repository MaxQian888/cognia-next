"use client"

// Resource-manager card — reads `PluginRateLimiter.DEFAULT_RATE_LIMITS`
// (16 categories) and displays each plugin's current usage. Without a
// per-call hook from the limiter, we render the configured ceiling and
// the most recent analytics counter for the matching key.

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { GaugeIcon } from "lucide-react"
import { usePluginAnalytics } from "@/hooks/plugins"

interface RateLimitMeta {
  key: string
  limit: number
  windowMs: number
}

interface Props {
  pluginId: string
  /** Limits live in `lib/plugin/security/rate-limiter.ts`. We accept them as
   * a prop so this component stays test-friendly and decoupled from the
   * singleton. Default to the manager's published defaults at the call site. */
  limits: RateLimitMeta[]
}

export function PluginResourceManager({ pluginId, limits }: Props) {
  const t = useTranslations("plugins.resourceManager")
  const analytics = usePluginAnalytics()
  const entry = analytics.byPlugin.find((p) => p.pluginId === pluginId)

  if (limits.length === 0) {
    return (
      <Card className="p-4 text-center space-y-1">
        <GaugeIcon className="size-8 mx-auto text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("noLimits")}</p>
      </Card>
    )
  }

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <GaugeIcon className="size-4" />
        <h3 className="text-sm font-semibold">{t("title")}</h3>
      </div>

      <ul className="space-y-2">
        {limits.map((rule) => {
          const used = entry?.byKey[rule.key]?.count ?? 0
          const ratio = rule.limit > 0 ? Math.min(used / rule.limit, 1) : 0
          const lastEventAt = entry?.byKey[rule.key]?.lastEventAt
          return (
            <li key={rule.key} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <code className="font-mono truncate">{rule.key}</code>
                <Badge variant="outline" className="text-xs shrink-0">
                  {used} / {rule.limit}
                </Badge>
              </div>
              <Progress value={ratio * 100} className="h-1.5" />
              {lastEventAt && (
                <div className="text-xs text-muted-foreground text-right">
                  {new Date(lastEventAt).toISOString().slice(0, 19).replace("T", " ")}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
