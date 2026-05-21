// ADR-0028 Phase 7 — Settings → Sandbox section.
//
// Surfaces the per-platform sandbox health, a "Run health probe" button,
// and a discrete badge for the strict-mode policy ("when unavailable,
// Bash/Edit/Write tool calls are refused — no bypass"). The default tier
// picker + per-tool network policy editor are deferred to follow-ups; the
// V1 surface focuses on visibility + manual retry.

"use client"

import { AlertCircle, CheckCircle2, RefreshCw, ShieldOff } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useSandboxHealth } from "@/hooks/sandbox/use-sandbox-health"

import { AutomationPolicyCard } from "./automation-policy-card"
import { SandboxTierCard } from "./sandbox-tier-card"

export function SandboxSection() {
  const t = useTranslations("settings.sandbox")
  const { health, refresh, error } = useSandboxHealth()

  const variant: "ok" | "setup" | "down" = error ? "down" : health.available ? "ok" : "setup"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {variant === "ok" ? (
              <CheckCircle2 className="size-5 text-emerald-500" aria-hidden="true" />
            ) : variant === "setup" ? (
              <AlertCircle className="size-5 text-amber-500" aria-hidden="true" />
            ) : (
              <ShieldOff className="size-5 text-rose-500" aria-hidden="true" />
            )}
            <span>{t("title")}</span>
            <Badge
              variant={variant === "ok" ? "default" : "secondary"}
              className="ml-2"
              data-testid="sandbox-status-badge"
            >
              {t(`status.${variant}`)}
            </Badge>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("backend.label")}</dt>
            <dd className="font-mono">{health.backend || "—"}</dd>
            <dt className="text-muted-foreground">{t("version.label")}</dt>
            <dd className="font-mono">{health.version || "—"}</dd>
            {health.lastError && (
              <>
                <dt className="text-muted-foreground">{t("lastError.label")}</dt>
                <dd className="font-mono text-rose-500">{health.lastError}</dd>
              </>
            )}
            {error && (
              <>
                <dt className="text-muted-foreground">{t("ipcError.label")}</dt>
                <dd className="font-mono text-rose-500">{error}</dd>
              </>
            )}
          </dl>
          <div className="flex items-center gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              data-testid="sandbox-retry-button"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("retryButton")}
            </Button>
            {variant !== "ok" && (
              <p className="text-xs text-muted-foreground">{t("strictModeNote")}</p>
            )}
          </div>
        </CardContent>
      </Card>
      <SandboxTierCard />
      <AutomationPolicyCard />
    </div>
  )
}
