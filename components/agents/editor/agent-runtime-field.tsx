"use client"

/**
 * An agent's default runtime (ADR-0220), as a form field. The picker is the
 * composer's own runtime chip in controlled mode, so the rows, their status
 * badges and the "add an external agent" entry are the ones the composer
 * shows; the only addition is the first row, "follow the app default".
 */

import { useTranslations } from "next-intl"
import type { CharacterRuntimeBinding } from "@cognia/agent-config-types"
import { Label } from "@/components/ui/label"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { findRuntimeByKey } from "@/lib/ai/agent/runtime-catalog/types"
import { runtimeBindingFromRef, runtimeBindingKey } from "@/lib/agents/runtime-binding"

export interface AgentRuntimeFieldProps {
  value: CharacterRuntimeBinding | undefined
  onChange: (next: CharacterRuntimeBinding | undefined) => void
  disabled?: boolean
}

export function AgentRuntimeField({ value, onChange, disabled }: AgentRuntimeFieldProps) {
  const t = useTranslations("agentsConsole.runtimeField")
  const { runtimes } = useAgentRuntimeCatalog(undefined, undefined)
  const key = value ? runtimeBindingKey(value) : undefined
  const row = key ? findRuntimeByKey(runtimes, key) : undefined
  // The builtin lane always resolves; a named agent that has no row here was
  // removed or is configured on another device.
  const unavailable = value !== undefined && value.kind !== "builtin" && row === undefined
  const storedName =
    value && value.kind !== "builtin"
      ? (value.name ?? (value.kind === "external" ? value.agentId : value.configId))
      : undefined

  return (
    <div
      className="space-y-1.5 rounded-md border bg-muted/20 p-3"
      data-testid="agent-runtime-field"
    >
      <Label className="text-xs font-medium">{t("label")}</Label>
      <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      <AgentRuntimeSelector
        variant="field"
        disabled={disabled}
        controlled={{
          selectedKey: key,
          onSelectRuntime: (picked) => onChange(runtimeBindingFromRef(picked.ref, picked.name)),
          defaultOption: {
            label: t("appDefault"),
            description: t("appDefaultDescription"),
            active: value === undefined,
            onSelect: () => onChange(undefined),
          },
          unavailableLabel: storedName ? t("unavailableLabel", { name: storedName }) : undefined,
        }}
      />
      {unavailable ? (
        <p className="text-[10px] text-destructive" role="status">
          {t("unavailableHint")}
        </p>
      ) : row?.warning ? (
        <p className="text-[10px] text-muted-foreground" role="status">
          {row.warning}
        </p>
      ) : null}
    </div>
  )
}
