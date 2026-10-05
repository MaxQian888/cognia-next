"use client"

/**
 * What sets one configuration of a runtime apart from its siblings (ADR-0216).
 *
 * Two configurations of one runtime carry the same icon, the same preset badge
 * and often a name that differs by "(copy)". The difference the user actually
 * chose — a permission mode, a private state root, a model — is what lets them
 * pick the right one, so every list that can show several of them renders it
 * through here: chips under a name, or one plain line inside a `<Select>`.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { BoxIcon, CopyIcon, LayersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  InstanceDifferenceKey,
  InstanceFamilyConfig,
} from "@/lib/ai/agent/external/config/instance-family"
import type { AcpPermissionMode } from "@/types/agent/external-agent"

/** One trait as `distinguishingTraits` reports it. */
export interface InstanceTrait {
  key: InstanceDifferenceKey
  value: string | null
}

const PERMISSION_MODES: readonly AcpPermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]

const SANDBOX_LABEL_KEY: Record<string, string> = {
  readOnly: "codexSandboxReadOnly",
  workspaceWrite: "codexSandboxWorkspaceWrite",
  dangerFullAccess: "codexSandboxDangerFullAccess",
}

function lastPathSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  return trimmed.split(/[\\/]/).at(-1) || trimmed
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/**
 * Translate one trait into a short phrase. Returns `null` for a trait whose
 * value is unset on this configuration and so says nothing about it.
 */
export function useInstanceTraitFormatter(): (trait: InstanceTrait) => string | null {
  const t = useTranslations("externalAgent.instances")
  const tSettings = useTranslations("externalAgent.settings")
  return useCallback(
    (trait: InstanceTrait) => {
      const { key, value } = trait
      switch (key) {
        case "permissionMode":
          // Short labels: a chip has no room for the settings form's sentence.
          return value && (PERMISSION_MODES as readonly string[]).includes(value)
            ? t(`traits.permission.${value as AcpPermissionMode}`)
            : null
        case "stateIsolation":
          return value === "isolated"
            ? t("traits.isolated")
            : value === "shared"
              ? t("traits.shared")
              : null
        case "model":
          return value ? t("traits.model", { value }) : t("traits.ownModel")
        case "account":
          return value ? t("traits.account") : t("traits.activeAccount")
        case "workingDirectory":
          return value ? t("traits.workingDirectory", { value: lastPathSegment(value) }) : null
        case "arguments":
          return value ? t("traits.arguments", { value }) : t("traits.noArguments")
        case "sandbox":
          return value && SANDBOX_LABEL_KEY[value] ? tSettings(SANDBOX_LABEL_KEY[value]) : null
        case "network":
          return value === "on"
            ? t("traits.networkOn")
            : value === "off"
              ? t("traits.networkOff")
              : null
        case "endpoint":
          return value ? endpointHost(value) : null
        case "sessionLimit":
          return value ? t("traits.sessionLimit", { count: Number(value) }) : null
        case "approvals":
          return value ? t("traits.approvals") : null
      }
    },
    [t, tSettings]
  )
}

/** The traits as one line, for a `<SelectItem>` or a tooltip. */
export function useInstanceTraitLine(): (traits: readonly InstanceTrait[], max?: number) => string {
  const format = useInstanceTraitFormatter()
  return useCallback(
    (traits, max = 3) =>
      traits
        .map(format)
        .filter((label): label is string => Boolean(label))
        .slice(0, max)
        .join(" · "),
    [format]
  )
}

/** Small chips under a name. Renders nothing when there is nothing to tell apart. */
export function InstanceTraitChips({
  traits,
  max = 3,
  className,
}: {
  traits: readonly InstanceTrait[]
  max?: number
  className?: string
}) {
  const format = useInstanceTraitFormatter()
  const labels = traits
    .map((trait) => ({ key: trait.key, label: format(trait) }))
    .filter((entry): entry is { key: InstanceDifferenceKey; label: string } => Boolean(entry.label))
  if (labels.length === 0) return null
  const shown = labels.slice(0, max)
  const hidden = labels.length - shown.length
  return (
    <span
      className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
      data-testid="instance-trait-chips"
    >
      {shown.map((entry) => (
        <Badge
          key={entry.key}
          variant="outline"
          className="h-4 max-w-[12rem] truncate px-1 text-[10px] font-normal text-muted-foreground"
        >
          {entry.label}
        </Badge>
      ))}
      {hidden > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
              tabIndex={0}
            >
              +{hidden}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {labels
              .slice(max)
              .map((entry) => entry.label)
              .join(" · ")}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

/**
 * Where this configuration keeps its runtime state. Says nothing for a
 * network agent: it has no local state to keep anywhere.
 */
export function StateIsolationBadge({
  config,
  className,
}: {
  config: Pick<InstanceFamilyConfig, "transport" | "stateIsolation">
  className?: string
}) {
  const t = useTranslations("externalAgent.instances")
  if (config.transport !== "stdio") return null
  const isolated = config.stateIsolation === "isolated"
  const Icon = isolated ? BoxIcon : LayersIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={isolated ? "secondary" : "outline"}
          className={cn("gap-1 text-xs font-normal", className)}
          tabIndex={0}
          data-testid="state-isolation-badge"
        >
          <Icon className="size-3" aria-hidden />
          {isolated ? t("traits.isolated") : t("traits.shared")}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {isolated ? t("isolatedHint") : t("sharedHint")}
      </TooltipContent>
    </Tooltip>
  )
}

/** "Copy of X", when the source still exists. */
export function DuplicatedFromHint({
  sourceName,
  onOpenSource,
  className,
}: {
  sourceName: string | null
  onOpenSource?: () => void
  className?: string
}) {
  const t = useTranslations("externalAgent.instances")
  if (!sourceName) return null
  const label = t("copyOf", { name: sourceName })
  return onOpenSource ? (
    <button
      type="button"
      onClick={onOpenSource}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
        className
      )}
      data-testid="duplicated-from-hint"
    >
      <CopyIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  ) : (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
        className
      )}
      data-testid="duplicated-from-hint"
    >
      <CopyIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  )
}
