"use client"

/**
 * The step after "Migration complete": actually connect the agent.
 *
 * Migration imported a coding agent's settings, commands, subagents and
 * history and then stopped, leaving the user to find the external-agent
 * settings and pick the right preset out of seventeen. The mapping needed to
 * skip that already existed in `lib/agent-ecosystem`.
 *
 * Renders nothing when there is nothing honest to offer: a vendor with no
 * launchable runtime, or a migration that imported nothing at all. See
 * `planRuntimeConnection`.
 *
 * `addAgentFromPreset` had no callers before this one. It creates a config
 * unconditionally, which is why the plan checks for an existing connection
 * first rather than letting a second migration produce a duplicate.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PlugZapIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { planRuntimeConnection } from "@/lib/agent-migration/connect-runtime"
import { getPresetDisplayInfo } from "@/lib/ai/agent/external/presets"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type { MigrationResult, MigrationVendor } from "@/lib/agent-migration/types"

export interface ConnectRuntimeCardProps {
  vendor: MigrationVendor
  result: MigrationResult
}

export function ConnectRuntimeCard({ vendor, result }: ConnectRuntimeCardProps) {
  const t = useTranslations("agentMigration")
  const agents = useExternalAgentStore((state) => state.agents)
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const plan = useMemo(
    () =>
      planRuntimeConnection({
        vendor,
        existingConfigs: agents,
        importedCounts: Object.values(result.artifacts).map((entry) => entry?.imported ?? 0),
      }),
    [vendor, agents, result]
  )

  if (!plan) return null

  const name = getPresetDisplayInfo(plan.presetId)?.name ?? plan.presetId
  const already = plan.existingAgentId !== null || connectedId !== null

  const connect = () => {
    setFailed(false)
    const id = useExternalAgentStore.getState().addAgentFromPreset(plan.presetId)
    if (id) setConnectedId(id)
    else setFailed(true)
  }

  return (
    <Card className="space-y-2 p-3" data-testid="connect-runtime-card">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{t("connectRuntime.title", { name })}</p>
          <p className="text-xs text-muted-foreground">{t("connectRuntime.body", { name })}</p>
        </div>
        {already ? (
          <span className="text-xs text-muted-foreground" data-testid="connect-runtime-connected">
            {t("connectRuntime.connected")}
          </span>
        ) : (
          <Button size="sm" onClick={connect} data-testid="connect-runtime-action">
            <PlugZapIcon className="mr-1 size-3.5" />
            {t("connectRuntime.action")}
          </Button>
        )}
      </div>
      {failed && (
        <p className="text-xs text-destructive" role="alert">
          {t("connectRuntime.failed")}
        </p>
      )}
    </Card>
  )
}
