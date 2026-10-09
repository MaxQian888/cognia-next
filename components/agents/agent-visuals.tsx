"use client"

/**
 * The small visual vocabulary of the agents console (ADR-0220): the avatar
 * with its live dot, the status word, the runtime label and the source
 * badges. One file so the rail, the detail and the builder can never draw the
 * same fact two ways.
 */

import { useTranslations } from "next-intl"
import { BotIcon, PlugZapIcon, ServerIcon } from "lucide-react"
import type { Character, CharacterRuntimeBinding } from "@cognia/agent-config-types"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Badge } from "@/components/ui/badge"
import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { findRuntimeByKey } from "@/lib/ai/agent/runtime-catalog/types"
import { runtimeBindingKey } from "@/lib/agents/runtime-binding"
import type { AgentLiveStatus } from "@/lib/agents/agent-activity"
import type { AgentSource } from "@/lib/agents/agent-source"
import { formatPackWarnings } from "@/components/settings/character/pack-trust-badges"
import { cn } from "@/lib/utils"

const DOT_CLASS: Record<AgentLiveStatus, string> = {
  running: "bg-emerald-500",
  awaiting: "bg-amber-500",
  idle: "bg-muted-foreground/40",
}

export function AgentStatusDot({
  status,
  className,
}: {
  status: AgentLiveStatus
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT_CLASS[status],
        status === "running" && "motion-safe:animate-pulse",
        className
      )}
    />
  )
}

export function AgentAvatar({
  agent,
  size = 32,
  status,
}: {
  agent: Pick<Character, "name" | "avatarColor" | "avatarEmoji" | "avatarImage">
  size?: number
  status?: AgentLiveStatus
}) {
  return (
    <AvatarBadge
      subject={{ ...agent, avatarImageUrl: agent.avatarImage?.webDataUrl }}
      size={size}
      textClassName={size >= 40 ? "text-lg" : "text-sm"}
      statusDot={
        status && status !== "idle" ? (
          <AgentStatusDot
            status={status}
            className="absolute bottom-0 right-0 ring-2 ring-background"
          />
        ) : undefined
      }
    />
  )
}

export function AgentStatusLabel({ status }: { status: AgentLiveStatus }) {
  const t = useTranslations("agentsConsole.status")
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        status === "running" && "text-emerald-600 dark:text-emerald-400",
        status === "awaiting" && "text-amber-600 dark:text-amber-400",
        status === "idle" && "text-muted-foreground"
      )}
      data-testid="agent-status"
      data-status={status}
    >
      <AgentStatusDot status={status} />
      {t(status)}
    </span>
  )
}

/**
 * What the agent's default runtime resolves to here: the app default, the
 * built-in lane, a named agent, or a named agent that is unavailable on this
 * device.
 */
export function AgentRuntimeLabel({
  runtime,
  className,
}: {
  runtime: CharacterRuntimeBinding | undefined
  className?: string
}) {
  const t = useTranslations("agentsConsole.runtime")
  const tRuntime = useTranslations("agentRuntime")
  const { runtimes } = useAgentRuntimeCatalog(undefined, undefined)
  if (!runtime) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}
      >
        <BotIcon className="size-3.5 shrink-0" aria-hidden />
        {t("appDefault")}
      </span>
    )
  }
  if (runtime.kind === "builtin") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs", className)}>
        <BotIcon className="size-3.5 shrink-0" aria-hidden />
        {tRuntime("cogniaAgent")}
      </span>
    )
  }
  const row = findRuntimeByKey(runtimes, runtimeBindingKey(runtime))
  const name =
    row?.name ?? runtime.name ?? (runtime.kind === "external" ? runtime.agentId : runtime.configId)
  const Icon = runtime.kind === "host" ? ServerIcon : PlugZapIcon
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs",
        !row && "text-destructive",
        className
      )}
      title={row ? name : t("unavailable", { name })}
      data-testid="agent-runtime-label"
      data-available={row ? "true" : "false"}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{row ? name : t("unavailable", { name })}</span>
    </span>
  )
}

/**
 * The badges that change what you can do with an agent: built-in (read-only),
 * a variant of another agent, a pack update waiting, a missing dependency.
 * Where it came from is a fact, not a warning, so it is in the Overview's
 * "About" rows rather than here.
 */
export function AgentSourceBadges({
  agent,
  source,
  baseName,
}: {
  agent: Character
  source: AgentSource
  /** The base's name when the agent is a variant. */
  baseName?: string
}) {
  const t = useTranslations("settings.characters")
  const quiet = "px-1.5 text-[10px] font-normal"
  const warn = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  return (
    <>
      {agent.isBuiltIn ? (
        <Badge variant="secondary" className={quiet}>
          {t("builtIn")}
        </Badge>
      ) : null}
      {agent.variant ? (
        <Badge
          variant="outline"
          className={quiet}
          title={t("variants.badgeTitle", { count: agent.variant.ownFields.length })}
        >
          {t("variants.badge", { base: baseName ?? agent.variant.baseId })}
        </Badge>
      ) : null}
      {source.updateAvailable ? (
        <Badge variant="outline" className={cn(quiet, warn)}>
          {t("badge.updateAvailable")}
        </Badge>
      ) : null}
      {source.warnings.length > 0 ? (
        <Badge
          variant="outline"
          className={cn(quiet, warn)}
          title={formatPackWarnings(source.warnings, t)}
        >
          {t("badge.missingDep", { count: source.warnings.length })}
        </Badge>
      ) : null}
    </>
  )
}
