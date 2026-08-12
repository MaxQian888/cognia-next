"use client"

/**
 * Teammate execution-binding field (ADR-0090 Phase 7).
 *
 * Edits `TeammateConfig.execution` — `inherit | pinned | pool` — with a live
 * delegation-mode preview: the candidate child spec implied by the current
 * binding is resolved through the SAME `resolveAgentExecutionSpec` authority
 * and classified via `decideDelegationMode` (the registry-time native filter
 * in `lib/claude/agents/subagents` is that decision's conservative
 * projection). Refs only: this field never accepts endpoints or key
 * material. While `agentExecutionResolverV2` is off, dispatch ignores the
 * binding — the field says so inline (flagOffHint).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { decideDelegationMode } from "@/lib/ai/agent/execution/delegation-mode"
import {
  getAgentExecutionFlags,
  isAgentExecutionFlagEnabled,
} from "@/lib/ai/agent/execution/feature-flags"
import { resolveTeammateExecutionBinding } from "@/lib/ai/agent/team/execution-binding-resolver"
import { resolveAgentExecutionSpec } from "@/lib/ai/agent/execution/resolve-agent-execution-spec"
import type { TeammateExecutionBinding } from "@/types/agent/agent-team"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"

export interface TeammateExecutionBindingFieldProps {
  value: TeammateExecutionBinding | undefined
  onChange: (next: TeammateExecutionBinding | undefined) => void
  /** Team-level default binding (preview baseline context). */
  teamDefault?: TeammateExecutionBinding
}

const MODEL_ROLE_INHERIT = "__inherit__"
const RUNTIME_AUTO = "__auto__"

function previewDecision(
  value: TeammateExecutionBinding | undefined,
  teamDefault: TeammateExecutionBinding | undefined
) {
  const environment = { isTauri: true, isHeadlessHost: false }
  const flags = getAgentExecutionFlags()
  const base = {
    surface: "team" as const,
    environment,
    flags,
    legacy: { toolsEnabled: true },
  }
  const parent = resolveAgentExecutionSpec(base).spec
  const binding = resolveTeammateExecutionBinding({ member: value, teamDefault })
  const child = resolveAgentExecutionSpec({ ...base, policy: binding.policy }).spec
  return decideDelegationMode(parent, child)
}

export function TeammateExecutionBindingField({
  value,
  onChange,
  teamDefault,
}: TeammateExecutionBindingFieldProps) {
  const t = useTranslations("agentTeamsWorkspace.teammateConfig.executionBinding")
  const { snapshot } = useFleetSnapshot()

  const mode = value?.mode ?? "inherit"
  const pinned = value?.mode === "pinned" ? value : undefined
  const pool = value?.mode === "pool" ? value : undefined
  const executionTarget = value?.executionTarget ?? { mode: "colocate" as const }
  const executionTargetPatch = value?.executionTarget ? { executionTarget } : {}
  const pinnedHostRef = executionTarget.mode === "pinned" ? executionTarget.hostRef : undefined
  const hosts = snapshot.hosts ?? []

  const decision = useMemo(() => previewDecision(value, teamDefault), [value, teamDefault])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{t("title")}</Label>
        <Badge
          variant={decision.mode === "native" ? "secondary" : "outline"}
          data-testid="delegation-mode-preview"
        >
          {decision.mode === "native"
            ? t("previewNative")
            : t("previewOrchestrated", { reasons: decision.reasons.join(", ") })}
        </Badge>
      </div>
      <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      {!isAgentExecutionFlagEnabled("agentExecutionResolverV2") && (
        <p className="text-[10px] text-amber-600 dark:text-amber-500" data-testid="flag-off-hint">
          {t("flagOffHint")}
        </p>
      )}
      <Select
        value={mode}
        onValueChange={(v) => {
          if (v === "inherit") onChange({ mode: "inherit", ...executionTargetPatch })
          else if (v === "pinned") onChange({ mode: "pinned", ...executionTargetPatch })
          else
            onChange({
              mode: "pool",
              candidateIds: pool?.candidateIds ?? [],
              ...executionTargetPatch,
            })
        }}
      >
        <SelectTrigger className="h-8 text-xs" data-testid="execution-binding-mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">{t("modeInherit")}</SelectItem>
          <SelectItem value="pinned">{t("modePinned")}</SelectItem>
          <SelectItem value="pool">{t("modePool")}</SelectItem>
        </SelectContent>
      </Select>

      <div className="space-y-1">
        <Label className="text-xs">{t("hostTarget")}</Label>
        <Select
          value={
            executionTarget.mode === "pinned"
              ? `host:${executionTarget.hostRef}`
              : executionTarget.mode
          }
          onValueChange={(next) =>
            onChange({
              ...(value ?? { mode: "inherit" }),
              executionTarget:
                next === "colocate"
                  ? { mode: "colocate" }
                  : next === "auto"
                    ? { mode: "auto" }
                    : { mode: "pinned", hostRef: next.slice("host:".length) },
            })
          }
        >
          <SelectTrigger className="h-8 text-xs" data-testid="execution-host-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="colocate">{t("hostLocal")}</SelectItem>
            <SelectItem value="auto">{t("hostAuto")}</SelectItem>
            {pinnedHostRef && !hosts.some((host) => host.hostRef === pinnedHostRef) ? (
              <SelectItem value={`host:${pinnedHostRef}`}>
                {t("hostPinnedOffline", { host: pinnedHostRef })}
              </SelectItem>
            ) : null}
            {hosts.map((host) => (
              <SelectItem key={host.hostRef} value={`host:${host.hostRef}`}>
                {host.online
                  ? t("hostPinned", { host: host.hostRef })
                  : t("hostPinnedOffline", { host: host.hostRef })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {executionTarget.mode === "pinned" &&
        !hosts.some((host) => host.hostRef === executionTarget.hostRef && host.online) ? (
          <p className="text-[10px] text-amber-600 dark:text-amber-500">
            {t("hostWaitingWarning")}
          </p>
        ) : null}
      </div>

      {pinned && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("runtimePolicy")}</Label>
            <Select
              value={pinned?.runtimePolicy ?? RUNTIME_AUTO}
              onValueChange={(v) =>
                onChange({
                  ...pinned,
                  runtimePolicy:
                    v === RUNTIME_AUTO ? undefined : (v as "claude-agent-sdk" | "ai-sdk"),
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={RUNTIME_AUTO}>{t("runtimeAuto")}</SelectItem>
                <SelectItem value="claude-agent-sdk">{t("runtimeClaudeSdk")}</SelectItem>
                <SelectItem value="ai-sdk">{t("runtimeAiSdk")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("modelRole")}</Label>
            <Select
              value={pinned?.modelRole ?? MODEL_ROLE_INHERIT}
              onValueChange={(v) =>
                onChange({
                  ...pinned,
                  modelRole:
                    v === MODEL_ROLE_INHERIT ? undefined : (v as "primary" | "fast" | "powerful"),
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MODEL_ROLE_INHERIT}>{t("modelRoleInherit")}</SelectItem>
                <SelectItem value="primary">{t("modelRolePrimary")}</SelectItem>
                <SelectItem value="fast">{t("modelRoleFast")}</SelectItem>
                <SelectItem value="powerful">{t("modelRolePowerful")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("deploymentRef")}</Label>
            <Input
              className="h-8 text-xs"
              placeholder={t("deploymentRefPlaceholder")}
              defaultValue={pinned?.deploymentRef ?? ""}
              onBlur={(e) =>
                onChange({
                  ...pinned,
                  deploymentRef: e.target.value.trim() || undefined,
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("credentialProfileRef")}</Label>
            <Input
              className="h-8 text-xs"
              placeholder={t("credentialProfileRefPlaceholder")}
              defaultValue={pinned?.credentialProfileRef ?? ""}
              onBlur={(e) =>
                onChange({
                  ...pinned,
                  credentialProfileRef: e.target.value.trim() || undefined,
                })
              }
            />
            <p className="text-[10px] text-muted-foreground">{t("credentialRefHint")}</p>
          </div>
        </div>
      )}

      {pool && (
        <div className="space-y-1">
          <Label className="text-xs">{t("candidateIds")}</Label>
          <Input
            className="h-8 text-xs"
            placeholder={t("candidateIdsPlaceholder")}
            defaultValue={pool.candidateIds.join(", ")}
            onBlur={(e) =>
              onChange({
                mode: "pool",
                candidateIds: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                ...executionTargetPatch,
              })
            }
          />
          <p className="text-[10px] text-muted-foreground">{t("candidateIdsHint")}</p>
        </div>
      )}
    </div>
  )
}
