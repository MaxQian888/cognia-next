"use client"

/**
 * The small facts that tell two configurations of one runtime apart at a
 * glance, shared by the list card and the detail header: where the agent's
 * state lives, and the runtime's display name for a group header.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { HardDriveIcon, UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { presetName } from "@/components/agent/external-agent/add-agent/preset-copy"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { stateIsolationOf, type HostAgentRuntimeKey } from "./host-agent-family"

/** "Own state" / "Shared state", always shown so the isolation in force is never implicit. */
export function HostAgentIsolationChip({ record }: { record: ExternalAgentConfigRecord }) {
  const t = useTranslations("mobile.externalAgents")
  const isolated = stateIsolationOf(record) === "isolated"
  const Icon = isolated ? HardDriveIcon : UsersIcon
  return (
    <Badge
      variant="outline"
      className="font-normal text-muted-foreground"
      data-testid={`host-agent-isolation-${record.configId}`}
      data-isolation={isolated ? "isolated" : "shared"}
    >
      <Icon aria-hidden />
      {isolated ? t("isolationOwn") : t("isolationShared")}
    </Badge>
  )
}

/** The display name of a runtime: its preset's (translated) name, or its command. */
export function useRuntimeName(): (
  runtime: HostAgentRuntimeKey,
  fallback: string
) => string {
  const tSettings = useTranslations("externalAgent.settings")
  return useCallback(
    (runtime, fallback) => {
      if (runtime.kind === "preset") {
        const preset = getPresetConfig(runtime.id)
        return preset ? presetName(tSettings, runtime.id, preset) : runtime.id
      }
      if (runtime.kind === "command") return runtime.command
      return fallback
    },
    [tSettings]
  )
}
