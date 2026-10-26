"use client"

import { useTranslations } from "next-intl"
import { CogniaModelPicker } from "@/components/agent/external-agent/cognia-model-picker"
import { RoleModelFields } from "@/components/agent/external-agent/role-model-fields"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"
import { compileEditorModelPlan } from "@/lib/ai/agent/external/config/cognia-model-options"
import { configModelRolesApply } from "@/lib/ai/agent/external/config/model-plan"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type { AppSettings } from "@cognia/agent-config-types"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import type { SubAgentConfig } from "@/types/agent/sub-agent"

type RuntimeConfig = Pick<
  ExternalAgentConfig,
  "protocol" | "transport" | "process" | "metadata" | "network" | "cogniaModel" | "modelRoles"
>

/** The connection a template's external run is judged against. */
function templateRuntime(
  config: Partial<SubAgentConfig>,
  pinned: RuntimeConfig | undefined
): RuntimeConfig | undefined {
  const preset = config.externalPresetId ? getPresetConfig(config.externalPresetId) : undefined
  if (!config.externalPresetId || (!pinned && !preset)) return undefined
  return (
    pinned ?? {
      protocol: preset!.protocol,
      transport: preset!.transport,
      process: preset!.process,
      network: preset!.network,
      metadata: { ...preset!.metadata, preset: config.externalPresetId },
    }
  )
}

/**
 * The pinned configuration's sub-task models a template's run inherits: none
 * when the template moves the run to another provider or account, which is
 * the rule admission applies (`configModelRolesApply`).
 */
function inheritedModelRoles(
  config: Partial<SubAgentConfig>,
  pinned: RuntimeConfig | undefined
): RuntimeConfig["modelRoles"] {
  return pinned?.modelRoles && configModelRolesApply(pinned.cogniaModel, config.cogniaModel)
    ? pinned.modelRoles
    : undefined
}

/**
 * Whether a template's sub-task models would be refused at dispatch, compiled
 * over the pinned configuration's overrides it inherits exactly as admission
 * compiles them. Unpinned templates are judged against the preset alone; the
 * config the dispatch resolves is checked again when the task starts.
 */
export function templateModelRolesInvalid(
  config: Partial<SubAgentConfig>,
  pinned: RuntimeConfig | undefined,
  settings: Pick<AppSettings, "providerSettings" | "customProviders"> | null | undefined
): boolean {
  const runtime = templateRuntime(config, pinned)
  const primary = config.cogniaModel ?? pinned?.cogniaModel
  const inherited = inheritedModelRoles(config, pinned)
  if (!runtime || !primary || (!config.modelRoles && !inherited)) return false
  return !compileEditorModelPlan({
    config: runtime,
    primary,
    layers: [
      { source: "subagent", overrides: config.modelRoles },
      ...(inherited ? [{ source: "config" as const, overrides: inherited }] : []),
    ],
    providerSettings: settings?.providerSettings ?? {},
    customProviders: settings?.customProviders,
  }).ok
}

/**
 * The Cognia model a template's external run uses, and its sub-task models.
 *
 * The connection judged is the pinned configuration when the template pins
 * one, else the preset's own launch shape. An unset template binding follows
 * the configuration the dispatch resolves, so turning the switch off clears
 * the template's binding (`undefined`) rather than forcing the native lane.
 * Sub-task rows edit the template layer: an unset row inherits the
 * configuration's choice.
 */
export function TemplateCogniaModelFields({
  config,
  onChange,
}: {
  config: Partial<SubAgentConfig>
  onChange: (patch: Pick<Partial<SubAgentConfig>, "cogniaModel" | "modelRoles">) => void
}) {
  const t = useTranslations("settings.subagents.templates")
  const pinned = useExternalAgentStore((state) =>
    config.externalAgentConfigId ? state.agents[config.externalAgentConfigId] : undefined
  )
  const runtime = templateRuntime(config, pinned)
  if (!runtime) return null
  const primary = config.cogniaModel ?? pinned?.cogniaModel ?? undefined
  return (
    <div className="space-y-2" data-testid="editor-cognia-model">
      <p className="text-[11px] text-muted-foreground">
        {t(pinned?.cogniaModel ? "cogniaModelPinnedHint" : "cogniaModelHint")}
      </p>
      <CogniaModelPicker
        config={runtime}
        value={config.cogniaModel ?? null}
        onChange={(cogniaModel) => onChange({ cogniaModel: cogniaModel ?? undefined })}
      />
      <RoleModelFields
        config={runtime}
        primary={primary}
        value={config.modelRoles}
        layer="subagent"
        inherited={inheritedModelRoles(config, pinned)}
        onChange={(modelRoles) => onChange({ modelRoles })}
      />
    </div>
  )
}
