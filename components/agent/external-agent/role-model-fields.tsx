"use client"

import { useEffect, useId, useMemo, useState } from "react"
import { resolvePiSubagents, piSubagentSupport } from "@/lib/ai/agent/external/config/pi-subagents"
import { useTranslations } from "next-intl"
import { groupByProvider } from "@cognia/provider-routing/model-option-source"
import { useSettingsStore } from "@/stores/settings"
import { useSubscriptionProviders } from "@/lib/subscription/core/hooks"
import {
  cogniaModelReasoningFacts,
  compileEditorModelPlan,
  filterCogniaGatewayModels,
} from "@/lib/ai/agent/external/config/cognia-model-options"
import {
  gatewayModelSlots,
  type AgentModelSlotDescriptor,
} from "@/lib/ai/agent/external/config/model-slots"
import type { TaskModelPlanRefusal } from "@/lib/ai/agent/external/config/model-plan"
import { ProviderModelList } from "@/components/settings/provider/provider-model-list"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  AgentModelRoleOverrides,
  AgentModelSlotSelection,
  ExternalAgentCogniaModelBinding,
  ExternalAgentConfig,
} from "@/types/agent/external-agent"

type RuntimeConfig = Pick<
  ExternalAgentConfig,
  "protocol" | "transport" | "process" | "metadata" | "network"
>

/**
 * Which layer the fields edit. A configuration is the lowest layer: an unset
 * slot there runs on the primary model. A subagent template sits above it: an
 * unset slot inherits the configuration's choice, and "primary model" is an
 * explicit choice that shields it.
 */
export type RoleModelLayer = "config" | "subagent"

/** Why the role rows cannot be edited right now, shown instead of the rows. */
export type RoleModelFieldsBlocker = "host-outdated"

const SLOT_LABEL_KEYS = {
  "subagent.default": "slots.subagentDefault",
  "tier.haiku": "slots.tierHaiku",
  "tier.sonnet": "slots.tierSonnet",
  "tier.opus": "slots.tierOpus",
  "aux.small": "slots.auxSmall",
} as const satisfies Record<AgentModelSlotDescriptor["id"], string>

const KIND_HINT_KEYS = {
  "child-default": "hints.childDefault",
  tier: "hints.tier",
  auxiliary: "hints.auxiliary",
} as const satisfies Record<AgentModelSlotDescriptor["kind"], string>

const REFUSAL_KEYS = {
  "unsupported-slot": "refusals.unsupportedSlot",
  "cross-provider-unsupported": "refusals.crossProvider",
  "cross-account-unsupported": "refusals.crossAccount",
  "effort-unsupported": "refusals.effortUnsupported",
  "too-many-models": "refusals.tooManyModels",
  "spawn-models-unsupported": "refusals.spawnModelsUnsupported",
  "default-spawn-model-not-allowed": "refusals.defaultSpawnModelNotAllowed",
} as const satisfies Record<TaskModelPlanRefusal, string>

const EFFORT_LABEL_KEYS: Record<string, string> = {
  minimal: "efforts.minimal",
  low: "efforts.low",
  medium: "efforts.medium",
  high: "efforts.high",
  xhigh: "efforts.xhigh",
}

const UNSET = "__unset__"
const PRIMARY = "__primary__"
const MODEL = "__model__"
const EFFORT_DEFAULT = "__default__"

function withSlot(
  value: AgentModelRoleOverrides | undefined,
  slot: string,
  selection: AgentModelSlotSelection | undefined
): AgentModelRoleOverrides | undefined {
  const slots = { ...value?.slots }
  if (selection) slots[slot] = selection
  else delete slots[slot]
  if (value?.version === 2) return { ...value, slots }
  return Object.keys(slots).length ? { version: 1, slots } : undefined
}

/**
 * Per-slot models for an external agent's gateway tasks: the default child
 * model, alias tiers and helper calls, as the runtime declares them in
 * `gatewayModelSlots`. Rendered under the primary {@link CogniaModelPicker};
 * every slot runs on the primary model's provider and account.
 *
 * Emits `undefined` once no slot is set, so an untouched configuration keeps
 * its historical single-model behaviour without a stored empty object.
 */
export function RoleModelFields({
  config,
  primary,
  value,
  onChange,
  layer = "config",
  inherited,
  blocker,
  spawnModelsSupported = true,
}: {
  config: RuntimeConfig
  /** The primary Cognia binding; `null`/absent means the native lane. */
  primary?: ExternalAgentCogniaModelBinding | null
  value?: AgentModelRoleOverrides
  onChange: (value: AgentModelRoleOverrides | undefined) => void
  layer?: RoleModelLayer
  /**
   * The configuration layer beneath a subagent template (its pinned config's
   * overrides), compiled under this layer exactly as admission will.
   */
  inherited?: AgentModelRoleOverrides
  blocker?: RoleModelFieldsBlocker
  spawnModelsSupported?: boolean
}) {
  const t = useTranslations("externalAgent.roleModels")
  const headingId = useId()
  const [candidatesOpen, setCandidatesOpen] = useState(false)
  const providerSettings = useSettingsStore((state) => state.settings?.providerSettings)
  const customProviders = useSettingsStore((state) => state.settings?.customProviders)
  const subscriptions = useSubscriptionProviders()
  const protocol = config.protocol
  const cwd = config.process?.cwd
  const agentDir = config.process?.env?.PI_CODING_AGENT_DIR
  const detectionKey = JSON.stringify([protocol, cwd, agentDir])
  const [detected, setDetected] = useState<{
    key: string
    snapshot?: ReturnType<typeof piSubagentSupport>
  } | null>(null)
  useEffect(() => {
    if (protocol !== "pi-rpc") return
    let cancelled = false
    const refresh = () => {
      void resolvePiSubagents({
        protocol,
        process: {
          command: "pi",
          cwd,
          env: agentDir ? { PI_CODING_AGENT_DIR: agentDir } : undefined,
        },
      })
        .then((resolved) => {
          if (!cancelled) setDetected({ key: detectionKey, snapshot: piSubagentSupport(resolved) })
        })
        .catch(() => {
          if (!cancelled) setDetected({ key: detectionKey })
        })
    }
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      cancelled = true
      window.removeEventListener("focus", refresh)
    }
  }, [protocol, cwd, agentDir, detectionKey])
  const effectiveConfig = useMemo(
    () =>
      protocol === "pi-rpc"
        ? {
            ...config,
            metadata: {
              ...config.metadata,
              cogniaPiSubagents: detected?.key === detectionKey ? detected.snapshot : undefined,
            },
          }
        : config,
    [protocol, config, detected, detectionKey]
  )
  const descriptors = gatewayModelSlots(effectiveConfig)
  const ready = !!primary?.providerId && !!primary.modelId
  const providerId = ready ? primary.providerId : undefined
  const options = useMemo(
    () =>
      providerId
        ? filterCogniaGatewayModels({ providerSettings, customProviders, subscriptions }).filter(
            (option) => option.providerId === providerId
          )
        : [],
    [providerId, providerSettings, customProviders, subscriptions]
  )
  const groups = useMemo(() => groupByProvider(options), [options])
  const facts = useMemo(
    () =>
      providerId
        ? cogniaModelReasoningFacts(providerId, {
            providerSettings: providerSettings ?? {},
            customProviders,
            subscriptions,
          })
        : undefined,
    [providerId, providerSettings, customProviders, subscriptions]
  )
  const refusal = useMemo(() => {
    if (!ready || (!value && !inherited)) return undefined
    const result = compileEditorModelPlan({
      config: effectiveConfig,
      primary,
      layers: [
        { source: layer, overrides: value },
        ...(layer === "subagent" && inherited
          ? [{ source: "config" as const, overrides: inherited }]
          : []),
      ],
      providerSettings: providerSettings ?? {},
      customProviders,
      subscriptions,
    })
    return result.ok ? undefined : result
  }, [
    ready,
    effectiveConfig,
    primary,
    layer,
    value,
    inherited,
    providerSettings,
    customProviders,
    subscriptions,
  ])

  if (!descriptors.length && !value) return null
  const stale = Object.keys(value?.slots ?? {}).filter(
    (slot) => !descriptors.some((descriptor) => descriptor.id === slot)
  )
  return (
    <section
      className="space-y-3 rounded-lg border p-3"
      aria-labelledby={headingId}
      data-testid="role-model-fields"
    >
      <div className="space-y-1">
        <h4 id={headingId} className="text-sm font-medium">
          {t("title")}
        </h4>
        <p className="text-muted-foreground text-xs">
          {blocker === "host-outdated"
            ? t("hostOutdated")
            : !ready
              ? t("needsPrimary")
              : descriptors.length
                ? t("description")
                : t("noSlots")}
        </p>
      </div>
      {ready &&
        blocker === undefined &&
        descriptors.map((descriptor) => (
          <RoleModelSlotRow
            key={descriptor.id}
            descriptor={descriptor}
            primary={primary}
            selection={value?.slots[descriptor.id]}
            layer={layer}
            groups={groups}
            effortValues={facts?.modelEffortValues}
            issue={refusal?.slot === descriptor.id ? refusal.reason : undefined}
            onChange={(selection) => onChange(withSlot(value, descriptor.id, selection))}
          />
        ))}
      {ready &&
        blocker === undefined &&
        descriptors.some((slot) => slot.supportsSpawnModelOverrides) && (
          <div className="space-y-2 border-t pt-3">
            <Label>{t("spawnModels")}</Label>
            <p className="text-xs text-muted-foreground">{t("spawnModelsDescription")}</p>
            {spawnModelsSupported ? (
              <>
                <ResponsivePicker
                  open={candidatesOpen}
                  onOpenChange={setCandidatesOpen}
                  title={t("spawnModels")}
                  trigger={
                    <Button type="button" variant="outline">
                      {t("addSpawnModel")}
                    </Button>
                  }
                >
                  <ProviderModelList
                    groups={groups}
                    searchPlaceholder={t("search", { provider: primary.providerId })}
                    emptyLabel={t("empty")}
                    onSelect={(_provider, modelId) => {
                      const current = value?.version === 2 ? (value.allowedSpawnModels ?? []) : []
                      const defaultModel =
                        value?.slots["subagent.default"] ?? inherited?.slots["subagent.default"]
                      const defaultBinding =
                        defaultModel?.kind === "cognia" ? defaultModel.binding : primary
                      const bindings = current.length ? [...current] : [defaultBinding]
                      if (!bindings.some((binding) => binding.modelId === modelId))
                        bindings.push({ ...primary, modelId })
                      onChange({
                        version: 2,
                        slots: value?.slots ?? {},
                        allowedSpawnModels: bindings,
                      })
                      setCandidatesOpen(false)
                    }}
                  />
                </ResponsivePicker>
                {value?.version === 2 &&
                  value.allowedSpawnModels?.map((binding) => (
                    <div key={binding.modelId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 break-all text-xs">{binding.modelId}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t("removeSpawnModel", { model: binding.modelId })}
                        onClick={() =>
                          onChange({
                            ...value,
                            allowedSpawnModels: value.allowedSpawnModels!.filter(
                              (item) => item.modelId !== binding.modelId
                            ),
                          })
                        }
                      >
                        {t("remove")}
                      </Button>
                    </div>
                  ))}
                {value?.version === 2 && value.allowedSpawnModels !== undefined && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onChange({ version: 2, slots: value.slots, allowedSpawnModels: [] })
                    }
                  >
                    {t("clearSpawnModels")}
                  </Button>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t("hostOutdated")}</p>
            )}
          </div>
        )}
      {stale.map((slot) => (
        <div
          key={slot}
          className="flex items-center justify-between gap-3 rounded-md border border-dashed p-2"
        >
          <p role="alert" className="text-destructive text-xs">
            {t("refusals.unsupportedSlot")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(withSlot(value, slot, undefined))}
            aria-label={t("removeStale")}
          >
            {t("remove")}
          </Button>
        </div>
      ))}
      {refusal &&
        !descriptors.some((descriptor) => descriptor.id === refusal.slot) &&
        !stale.includes(refusal.slot ?? "") && (
          <p role="alert" className="text-destructive text-xs">
            {t(REFUSAL_KEYS[refusal.reason], { provider: primary?.providerId ?? "" })}
          </p>
        )}
    </section>
  )
}

function RoleModelSlotRow({
  descriptor,
  primary,
  selection,
  layer,
  groups,
  effortValues,
  issue,
  onChange,
}: {
  descriptor: AgentModelSlotDescriptor
  primary: ExternalAgentCogniaModelBinding
  selection?: AgentModelSlotSelection
  layer: RoleModelLayer
  groups: ReturnType<typeof groupByProvider>
  /** The efforts a model accepts; the row offers the slot ladder narrowed to these. */
  effortValues?: (modelId: string) => readonly string[]
  issue?: TaskModelPlanRefusal
  onChange: (selection: AgentModelSlotSelection | undefined) => void
}) {
  const t = useTranslations("externalAgent.roleModels")
  const id = useId()
  const [open, setOpen] = useState(false)
  const label = t(SLOT_LABEL_KEYS[descriptor.id])
  const mode = !selection ? UNSET : selection.kind === "inherit-primary" ? PRIMARY : MODEL
  const model = selection?.kind === "cognia" ? selection : undefined
  const pick = (modelId: string) => {
    onChange({
      kind: "cognia",
      binding: { providerId: primary.providerId, modelId },
      ...(model?.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    })
    setOpen(false)
  }
  return (
    <div className="space-y-2" data-testid={`role-model-slot-${descriptor.id}`}>
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground text-xs">{t(KIND_HINT_KEYS[descriptor.kind])}</p>
      </div>
      <Select
        value={mode}
        onValueChange={(next) => {
          if (next === UNSET) onChange(undefined)
          else if (next === PRIMARY) onChange({ kind: "inherit-primary" })
          else if (!model) setOpen(true)
        }}
      >
        <SelectTrigger id={id} aria-label={t("modeLabel", { slot: label })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>
            {t(layer === "subagent" ? "modes.inherit" : "modes.primary")}
          </SelectItem>
          {layer === "subagent" && <SelectItem value={PRIMARY}>{t("modes.primary")}</SelectItem>}
          <SelectItem value={MODEL}>{t("modes.model")}</SelectItem>
        </SelectContent>
      </Select>
      {(mode === MODEL || open) && (
        <ResponsivePicker
          open={open}
          onOpenChange={setOpen}
          title={t("modelLabel", { slot: label })}
          trigger={
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              aria-label={t("modelLabel", { slot: label })}
            >
              {model ? `${model.binding.providerId} / ${model.binding.modelId}` : t("choose")}
            </Button>
          }
        >
          <ProviderModelList
            groups={groups}
            activeProviderId={model?.binding.providerId}
            activeModelId={model?.binding.modelId}
            searchPlaceholder={t("search", { provider: primary.providerId })}
            emptyLabel={t("empty")}
            onSelect={(_providerId, modelId) => pick(modelId)}
          />
        </ResponsivePicker>
      )}
      {model && descriptor.reasoningEfforts && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-effort`}>{t("effort")}</Label>
          <Select
            value={model.reasoningEffort ?? EFFORT_DEFAULT}
            onValueChange={(effort) =>
              onChange({
                kind: "cognia",
                binding: model.binding,
                ...(effort === EFFORT_DEFAULT ? {} : { reasoningEffort: effort }),
              })
            }
          >
            <SelectTrigger id={`${id}-effort`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EFFORT_DEFAULT}>{t("effortDefault")}</SelectItem>
              {descriptor.reasoningEfforts
                .filter(
                  (effort) =>
                    effort === model.reasoningEffort ||
                    !effortValues ||
                    effortValues(model.binding.modelId).includes(effort)
                )
                .map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {EFFORT_LABEL_KEYS[effort] ? t(EFFORT_LABEL_KEYS[effort]) : effort}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {model && <p className="text-muted-foreground text-xs">{t("sameAccount")}</p>}
      {issue && (
        <p role="alert" className="text-destructive text-xs">
          {t(REFUSAL_KEYS[issue], { provider: primary.providerId })}
        </p>
      )}
    </div>
  )
}
