"use client"

// EXPERIMENTAL opt-in card (ADR-0090 Phase 4): run this Anthropic-protocol
// deployment through the Claude Agent SDK via the built-in Gateway
// (runtimePolicy claude-agent-sdk + routePolicy gateway-required).
//
// Rules the plan pins:
//  - visible ONLY behind the `experimentalAnthropicDeploymentAgentSdk` flag;
//  - writes the execution POLICY (settings field), NEVER any compatibility
//    record — certification is a separate signed artifact (Phase 5);
//  - the consequence copy makes the unsupported/billable nature explicit.

import { useTranslations } from "next-intl"
import { FlaskConical } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { isAgentExecutionFlagEnabled } from "@/lib/ai/agent/execution/feature-flags"

export interface DeploymentAgentSdkCardProps {
  providerId: string
  /** Only Anthropic-protocol deployments can carry the opt-in. */
  protocol: string
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function DeploymentAgentSdkCard({
  providerId,
  protocol,
  enabled,
  onChange,
}: DeploymentAgentSdkCardProps) {
  const t = useTranslations("providers")

  if (protocol !== "anthropic") return null
  if (!isAgentExecutionFlagEnabled("experimentalAnthropicDeploymentAgentSdk")) return null

  const switchId = `agent-sdk-experimental-${providerId}`
  return (
    <div
      data-testid="deployment-agent-sdk-card"
      className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-amber-500" aria-hidden />
          <Label htmlFor={switchId} className="font-medium">
            {t("agentSdkExperimentalTitle")}
          </Label>
          <Badge variant="outline" className="border-amber-500/60 text-amber-600">
            {t("agentSdkExperimentalBadge")}
          </Badge>
        </div>
        <Switch id={switchId} checked={enabled} onCheckedChange={onChange} />
      </div>
      <p className="text-xs text-muted-foreground">{t("agentSdkExperimentalBody")}</p>
      <p className="text-xs text-muted-foreground">{t("agentSdkExperimentalConsequence")}</p>
    </div>
  )
}
