"use client"

/**
 * Runtime chip — the one dropdown that answers "what will this turn run as":
 * cognia-next's bundled Claude SDK sidecar, or one of the configured External
 * Agents (Codex / Claude Code CLI / Gemini CLI / Cursor / any custom command).
 *
 * It used to pick the runtime *kind* only, leaving the actual agent record to a
 * sibling `<ExternalAgentSelector>` parked in the composer's "⋯" overflow.
 * Choosing "External agent" therefore left the chip reading
 * `External (none selected)` — a state that cannot send a turn — and its only
 * cure lived two clicks deep in a menu nothing pointed at. The agents are now
 * listed here as peers of the built-in runtime: one click picks the lane AND
 * the agent, so the chip can only ever name something that is able to run.
 *
 * Pairs with `<AgentModeSelector>` (Agent Modes, orthogonal to runtime).
 */

import { useEffect, useReducer, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BotIcon,
  ChevronDownIcon,
  PlugZapIcon,
  PowerIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { BrandIcon } from "@/components/icons/brand-icon"
import { ConnectionStatusBadge } from "@/components/agent/external-agent/connection-status-badge"
import { ExternalAgentManager } from "@/components/agent/external-agent/manager"
import { cn } from "@/lib/utils"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useHostExternalAgentConfigs } from "@/hooks/agent/use-host-external-agent-configs"
import { ServerCogIcon } from "lucide-react"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { hydrateAgentConfig } from "@/stores/agent/external-agent-store/selectors"
import { selectExternalAgent } from "@/lib/agent/external-agent-selection"
import { getExternalAgentExecutionBlock } from "@/lib/ai/agent/external/config-normalizer"
import { onProtocolAdapterRegistryChange } from "@/lib/ai/agent/external/protocol-adapter"
import { isFromPreset } from "@/lib/ai/agent/external/presets"
import type {
  ExternalAgentConfig,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"

interface Props {
  className?: string
  /** Disable the selector externally (e.g. while a turn is streaming). */
  disabled?: boolean
}

/** Radio value prefix for an external agent row (`claude-sdk` is the peer). */
const EXTERNAL_VALUE_PREFIX = "external:"
/** Radio value prefix for a configuration the paired host owns. */
const HOST_VALUE_PREFIX = "host:"

interface RuntimeAgentRow {
  agent: ExternalAgentConfig
  /**
   * Why this agent cannot execute at all — `null` when it can. Derived from the
   * config alone (disabled, unsupported protocol, unavailable plugin adapter,
   * no host that can spawn a process), so it is authoritative *now* and the row
   * is not selectable.
   */
  blockedReason: string | null
  /**
   * The block may clear itself (a plugin adapter that has not registered yet),
   * so it must not be used to rewrite persisted state. The row still renders
   * disabled — that self-corrects on the next registry tick.
   */
  blockTransient: boolean
  /**
   * What the last real contact with the agent found: a failed connect, a
   * pending sign-in, an unhealthy probe. This is history, not a verdict — a
   * binary that was missing an hour ago may be installed now — so it reads as a
   * warning and never blocks the choice.
   */
  warning: string | null
}

export function AgentRuntimeSelector({ className, disabled }: Props) {
  const t = useTranslations("agentRuntime")
  const tExternal = useTranslations("externalAgent")
  const tHostConfigs = useTranslations("externalAgent.hostConfigs")
  const [manageOpen, setManageOpen] = useState(false)

  const runtime = useAgentRuntimeStore((s) => s.runtime)
  const setRuntime = useAgentRuntimeStore((s) => s.setRuntime)
  const externalAgentId = useAgentRuntimeStore((s) => s.externalAgentId)
  const externalHostConfig = useAgentRuntimeStore((s) => s.externalHostConfig)
  const setExternalHostConfig = useAgentRuntimeStore((s) => s.setExternalHostConfig)

  // Configurations the paired host owns. Loaded here rather than passed in
  // because the picker is where the choice is made, and the hook already
  // answers "no host" / "host too old" without this component branching on a
  // platform. A host that cannot serve them simply contributes no rows.
  const { configs: hostConfigs, unavailable: hostUnavailable } = useHostExternalAgentConfigs()
  const hostRows = hostUnavailable
    ? []
    : hostConfigs.filter((record) => record.enabled && record.lifecycleStatus === "ready")

  const externalEnabled = useExternalAgentStore((s) => s.enabled)
  const setExternalEnabled = useExternalAgentStore((s) => s.setEnabled)
  const storedAgents = useExternalAgentStore((s) => s.agents)
  const agentValidity = useExternalAgentStore((s) => s.agentValidity)

  // A plugin-contributed protocol adapter can register/unregister at any time
  // and the registry is not reactive, so a row's blocked reason would otherwise
  // stay stale until the next store write. The rows are derived on every render
  // rather than memoized: the re-render this forces IS the refresh, and
  // `hydrateAgentConfig` is identity-cached per stored record anyway.
  const [, bumpRegistryTick] = useReducer((tick: number) => tick + 1, 0)
  useEffect(() => onProtocolAdapterRegistryChange(() => bumpRegistryTick()), [])

  const configuredCount = Object.keys(storedAgents ?? {}).length
  const rows: RuntimeAgentRow[] = externalEnabled
    ? Object.values(storedAgents ?? {})
        .map((stored) => {
          const agent = hydrateAgentConfig(stored)
          const block = getExternalAgentExecutionBlock(agent)
          const blockedReason = block?.reason ?? null
          return {
            agent,
            blockedReason,
            blockTransient: block?.transient === true,
            warning: blockedReason ? null : validityWarning(agentValidity?.[agent.id], t),
          }
        })
        .sort((a, b) => a.agent.name.localeCompare(b.agent.name))
    : []

  const selectedRow =
    runtime === "external" && externalAgentId
      ? (rows.find((row) => row.agent.id === externalAgentId) ?? null)
      : null

  // A persisted external selection outlives the agent that justified it: the
  // agent gets deleted, disabled, or its plugin adapter unregisters, and the
  // composer is left on a lane that cannot dispatch. Fall back to the built-in
  // runtime instead of picking a replacement — inventing a different agent for
  // the user is a worse surprise than landing back on the default.
  const selectedRunnable = !!selectedRow && !selectedRow.blockedReason
  // ...but only for a block that has actually settled. This chip is always
  // mounted and its state hydrates synchronously from localStorage, while a
  // plugin's protocol adapter registers asynchronously during plugin-manager
  // bootstrap — so at first render every plugin-contributed agent reads as
  // blocked. Persisting the fallback there rewrote the user's chosen agent to
  // `claude-sdk` on every restart, and the registry tick that follows only
  // re-renders: it never restored the selection. A row whose agent is missing
  // entirely (deleted, or its store entry gone) has no assessment to consult
  // and stays a settled block.
  const fallbackSettled = !selectedRow || !selectedRow.blockTransient
  // A host selection is runnable on its own terms, so it must suppress the
  // fallback: the local rows say nothing about it, and without this the chip
  // would bounce every host selection straight back to the built-in runtime.
  const holdsHostSelection = runtime === "external" && !!externalHostConfig
  useEffect(() => {
    if (holdsHostSelection) return
    if (runtime === "external" && !selectedRunnable && fallbackSettled) setRuntime("claude-sdk")
  }, [runtime, selectedRunnable, fallbackSettled, holdsHostSelection, setRuntime])

  // A host selection whose configuration is gone (deleted on the host, or the
  // host swapped underneath the tab) is dropped rather than replaced: naming a
  // different agent for the user is a worse surprise than landing on the
  // default, which is the same rule the local lane follows above.
  const hostSelection =
    runtime === "external" && externalHostConfig
      ? (hostRows.find((row) => row.configId === externalHostConfig.configId) ?? null)
      : null

  const value = hostSelection
    ? `${HOST_VALUE_PREFIX}${hostSelection.configId}`
    : selectedRunnable
      ? `${EXTERNAL_VALUE_PREFIX}${externalAgentId}`
      : runtime === "external"
        ? EXTERNAL_VALUE_PREFIX
        : "claude-sdk"

  const Icon = runtime === "external" ? PlugZapIcon : BotIcon
  const label =
    runtime === "external"
      ? ((hostSelection
          ? ((hostSelection.config as { name?: string }).name ?? externalHostConfig?.name)
          : selectedRow?.agent.name) ?? t("externalUnconfigured"))
      : t("claudeSdk")
  // The label is earned by being a choice. On the built-in runtime the chip
  // spelled "Claude SDK" under every single turn — the one value it can never
  // be wrong about — while the composer's status line ran out of room and its
  // neighbours overlapped. Off the default lane the agent's NAME is the whole
  // point of the chip, so it always spells that out. The tooltip and the
  // aria-label carry the wording in both states, so nothing is only visual.
  const namesAChoice = runtime === "external"

  const handleValueChange = (next: string) => {
    if (next === "claude-sdk") {
      setRuntime("claude-sdk")
      return
    }
    if (next.startsWith(HOST_VALUE_PREFIX)) {
      const configId = next.slice(HOST_VALUE_PREFIX.length)
      const record = hostRows.find((row) => row.configId === configId)
      if (!record) return
      // The stamp is captured at selection time. It is what the host admits
      // the run against, so a configuration edited between this click and the
      // send is refused rather than run — which is the whole point of carrying
      // a revision instead of a bare id.
      setExternalHostConfig({
        configId: record.configId,
        revision: record.revision,
        lifecycleGeneration: record.lifecycleGeneration,
        name: (record.config as { name?: string }).name ?? record.configId,
      })
      setRuntime("external")
      return
    }
    const agentId = next.startsWith(EXTERNAL_VALUE_PREFIX)
      ? next.slice(EXTERNAL_VALUE_PREFIX.length)
      : ""
    const row = rows.find((candidate) => candidate.agent.id === agentId)
    if (!row || row.blockedReason) return
    // Agent first: the fallback effect above reads both fields, and setting the
    // runtime first would briefly describe an external lane with no agent.
    // `selectExternalAgent` writes the runtime store AND the external-agent
    // store, which is what keeps the manager's idea of "active" and chat
    // dispatch's idea of "which agent" the same thing.
    selectExternalAgent(agentId)
    setRuntime("external")
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={disabled}
            className={cn(
              "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-muted/35 px-2 text-[11px] text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
              className,
              // Glyph-only on the default runtime: square it up so it reads as
              // a peer of the other icon-sized status controls rather than a
              // chip with a missing label. After `className` so the host's chip
              // padding doesn't re-inflate the square.
              !namesAChoice && "w-7 justify-center px-0"
            )}
            aria-label={`${t("ariaLabel")} — ${label}`}
            data-testid="agent-runtime-trigger"
            data-labelled={namesAChoice || undefined}
          >
            <Icon className="size-3.5 shrink-0" />
            {namesAChoice ? (
              <>
                <span className="min-w-0 truncate font-medium">{label}</span>
                <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
              </>
            ) : null}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t("tooltip")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={8} className="w-80 rounded-xl p-1.5">
        <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
          <DropdownMenuRadioItem value="claude-sdk">
            <BotIcon className="mr-2 size-4" />
            <div className="flex flex-col">
              <span className="text-sm">{t("claudeSdk")}</span>
              <span className="text-[10px] text-muted-foreground">{t("claudeSdkDesc")}</span>
            </div>
          </DropdownMenuRadioItem>

          {rows.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                {tExternal("externalAgents")}
              </DropdownMenuLabel>
              {rows.map(({ agent, blockedReason, warning }) => (
                <DropdownMenuRadioItem
                  key={agent.id}
                  value={`${EXTERNAL_VALUE_PREFIX}${agent.id}`}
                  disabled={!!blockedReason}
                  data-testid={`runtime-external-${agent.id}`}
                >
                  <BrandIcon
                    id={isFromPreset(agent) ?? agent.name}
                    label={agent.name}
                    size={16}
                    className="mr-2 shrink-0"
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{agent.name}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1">
                      <Badge variant="outline" className="h-4 px-1 text-[10px]">
                        {agent.protocol.toUpperCase()}
                      </Badge>
                      <ExternalAgentStatus agentId={agent.id} />
                    </span>
                    {blockedReason || warning ? (
                      <span className="mt-0.5 line-clamp-2 text-[10px] text-amber-600 dark:text-amber-400">
                        {blockedReason ?? warning}
                      </span>
                    ) : null}
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </>
          ) : null}

          {/* Agents the paired host owns. A separate group, not merged with the
              local rows: a local agent runs where this shell can spawn a
              process, and on a browser that is nowhere — so presenting the two
              as interchangeable would be the misleading part. Only ready,
              enabled configurations appear; the rest are actionable on the
              settings page, not here. */}
          {hostRows.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-[10px] font-normal">
                {tHostConfigs("title")}
              </DropdownMenuLabel>
              {hostRows.map((record) => {
                const config = record.config as { name?: string; protocol?: string }
                return (
                  <DropdownMenuRadioItem
                    key={record.configId}
                    value={`${HOST_VALUE_PREFIX}${record.configId}`}
                    data-testid={`runtime-host-${record.configId}`}
                  >
                    <ServerCogIcon className="mr-2 size-4 shrink-0" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{config.name ?? record.configId}</span>
                      {config.protocol ? (
                        <span className="mt-0.5 flex items-center gap-1">
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">
                            {config.protocol.toUpperCase()}
                          </Badge>
                        </span>
                      ) : null}
                    </div>
                  </DropdownMenuRadioItem>
                )
              })}
            </>
          ) : null}
        </DropdownMenuRadioGroup>

        {/* Three different "no agents to pick" states, each with the action that
            resolves it. They used to collapse into one sentence pointing at a
            Settings page — while the dialog that actually adds an agent sat two
            rows below, unmentioned. */}
        {!externalEnabled ? (
          <>
            <p className="px-2 pt-1.5 text-[10px] text-muted-foreground">
              {t("externalTurnedOff")}
            </p>
            <DropdownMenuItem
              onSelect={() => setExternalEnabled(true)}
              className="gap-2"
              data-testid="runtime-enable-external"
            >
              <PowerIcon className="size-4" />
              {t("enableExternal")}
            </DropdownMenuItem>
          </>
        ) : rows.length === 0 ? (
          <p className="px-2 py-1.5 text-[10px] text-muted-foreground">{t("externalEmpty")}</p>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => setManageOpen(true)}
          className="gap-2"
          data-testid="runtime-manage-agents"
        >
          <SlidersHorizontalIcon className="size-4" />
          {/* Same dialog either way — but "Manage" reads as housekeeping to
              someone who has nothing to manage yet. */}
          {configuredCount === 0 ? t("addExternalAgent") : tExternal("manageAgents")}
        </DropdownMenuItem>
      </DropdownMenuContent>

      {/* Sibling of the content, not a child of it: the item that opens this
          closes the menu, which unmounts `DropdownMenuContent` and would take
          the dialog with it. */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{tExternal("manageAgents")}</DialogTitle>
          </DialogHeader>
          <ExternalAgentManager className="min-h-0 flex-1" />
        </DialogContent>
      </Dialog>
    </DropdownMenu>
  )
}

/** Live connection state for one row, subscribed per-agent to avoid re-rendering
 *  the whole list on an unrelated agent's status change. */
function ExternalAgentStatus({ agentId }: { agentId: string }) {
  const status = useExternalAgentStore((s) => s.connectionStatus[agentId] ?? "disconnected")
  return <ConnectionStatusBadge status={status} className="h-4 px-1.5 text-[10px]" />
}

/**
 * The one-line "you may want to fix this first" for a selectable agent, read
 * from the validity snapshot the manager writes on every connect / health check
 * / execution (`useExternalAgent`). Ordered by how much it costs the user to
 * find out the hard way: an agent that failed to start, then one waiting on a
 * sign-in, then one whose last health probe came back bad.
 *
 * `blockingReason` is the runtime's own wording (a spawn error, a missing
 * binary) and is shown verbatim — inventing a translated paraphrase would drop
 * the detail that makes it actionable.
 */
function validityWarning(
  validity: ExternalAgentValiditySnapshot | undefined,
  t: (key: string) => string
): string | null {
  if (!validity) return null
  if (validity.executable === false) return validity.blockingReason ?? t("lastCheckFailed")
  if (validity.negotiation?.authRequired) return t("needsAuth")
  if (validity.healthStatus === "unhealthy") return t("lastCheckFailed")
  return null
}

export default AgentRuntimeSelector
