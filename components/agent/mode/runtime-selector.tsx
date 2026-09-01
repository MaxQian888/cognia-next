"use client"

/**
 * Runtime chip, the one dropdown that answers "what will this turn run as":
 * Cognia's own runtime in the bundled sidecar, one of the configured External
 * Agents (Codex / Claude Code CLI / Gemini CLI / Cursor / any custom command),
 * or a configuration the paired host owns.
 *
 * It used to pick the runtime *kind* only, leaving the actual agent record to a
 * sibling selector parked in the composer's "..." overflow. Choosing "External
 * agent" therefore left the chip reading `External (none selected)`, a state
 * that cannot send a turn, and its only cure lived two clicks deep in a menu
 * nothing pointed at. Every runtime is now a row in one catalog
 * (`lib/ai/agent/runtime-catalog`), and the selection is one
 * `AgentRuntimeRef`, so one click picks the lane AND the target and the chip
 * can only ever name something able to run.
 *
 * Pairs with `<AgentModeSelector>` (Agent Modes, orthogonal to runtime).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BotIcon,
  ChevronDownIcon,
  PlugZapIcon,
  PowerIcon,
  ServerCogIcon,
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
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { selectExternalAgent } from "@/lib/agent/external-agent-selection"
import { BUILTIN_RUNTIME_REF } from "@/lib/ai/agent/runtime-catalog/types"
import type { AgentRuntimeDescriptor, AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"

interface Props {
  className?: string
  /** Disable the selector externally (e.g. while a turn is streaming). */
  disabled?: boolean
  /**
   * The conversation this chip belongs to. The lane is per session (ADR-0117's
   * split, extended to the runtime axis), so without it the chip would write
   * the app default and retarget every other conversation.
   */
  sessionId?: string
  /**
   * The provider the next turn will use. It decides which sidecar runtime the
   * builtin row is really describing, which is the whole reason the row can
   * stop claiming "Anthropic SDK sidecar" on a DeepSeek session.
   */
  providerId?: string
}

export function AgentRuntimeSelector({ className, disabled, providerId, sessionId }: Props) {
  const t = useTranslations("agentRuntime")
  const tExternal = useTranslations("externalAgent")
  const tHostConfigs = useTranslations("externalAgent.hostConfigs")
  const [manageOpen, setManageOpen] = useState(false)

  const runtimeRef = useRuntimeRefForSession(sessionId)
  const setDefaultRuntimeRef = useAgentRuntimeStore((s) => s.setRuntimeRef)
  const setSessionRuntimeRef = useAgentRuntimeStore((s) => s.setSessionRuntimeRef)
  const setExternalEnabled = useExternalAgentStore((s) => s.setEnabled)

  // Writing the app default when there is no session is what a composer on the
  // new-chat surface should do: the choice seeds the conversation it starts.
  const setRuntimeRef = useCallback(
    (ref: AgentRuntimeRef) => {
      if (sessionId) setSessionRuntimeRef(sessionId, ref)
      else setDefaultRuntimeRef(ref)
    },
    [sessionId, setSessionRuntimeRef, setDefaultRuntimeRef]
  )

  const { runtimes, selected, externalEnabled, configuredExternalCount } =
    useAgentRuntimeCatalog(providerId)

  const externalRows = runtimes.filter((row) => row.group === "external")
  const hostRows = runtimes.filter((row) => row.group === "host")

  // A persisted selection outlives the agent that justified it: the agent gets
  // deleted, disabled, or its plugin adapter unregisters, and the composer is
  // left on a lane that cannot dispatch. Fall back to the builtin runtime
  // rather than picking a replacement, because inventing a different agent for
  // the user is a worse surprise than landing back on the default.
  //
  // Only for a block that has actually SETTLED. This chip is always mounted and
  // its state hydrates synchronously from localStorage, while a plugin's
  // protocol adapter registers asynchronously during plugin-manager bootstrap,
  // so at first render every plugin-contributed agent reads as blocked.
  // Persisting the fallback there rewrote the user's chosen agent to the
  // default on every restart, and the registry tick that follows only
  // re-renders: it never restored the selection.
  //
  // A LOCAL agent with no row at all is also settled: the agent was deleted, or
  // External Agents were switched off, and either way the local list is
  // authoritative right now. A HOST selection with no row is not, because the
  // host configuration list loads asynchronously and a valid selection has no
  // row during its first frames.
  const missingLocalAgent = runtimeRef.kind === "external" && !selected
  const settledBlock = !!selected?.blockedReason && selected.blockTransient !== true
  const needsFallback = missingLocalAgent || settledBlock
  useEffect(() => {
    if (needsFallback) setRuntimeRef(BUILTIN_RUNTIME_REF)
  }, [needsFallback, setRuntimeRef])

  const onBuiltin = runtimeRef.kind === "builtin"
  const value = selected?.key ?? (onBuiltin ? "builtin" : "")
  const Icon = onBuiltin ? BotIcon : PlugZapIcon
  const label = onBuiltin
    ? t("cogniaAgent")
    : // The cached host label covers the frames before the host list resolves,
      // where the descriptor does not exist yet but the selection is valid.
      (selected?.name ??
      (runtimeRef.kind === "host" ? runtimeRef.name : undefined) ??
      t("externalUnconfigured"))
  // The label is earned by being a choice. On the builtin runtime the chip
  // spelled one fixed word under every single turn, the one value it can never
  // be wrong about, while the composer's status line ran out of room and its
  // neighbours overlapped. Off the default lane the agent's NAME is the whole
  // point of the chip, so it always spells that out. The tooltip and the
  // aria-label carry the wording in both states, so nothing is only visual.
  const namesAChoice = !onBuiltin

  const handleValueChange = (next: string) => {
    const row = runtimes.find((candidate) => candidate.key === next)
    if (!row || row.blockedReason) return
    // `selectExternalAgent` writes the external-agent store too, which is what
    // keeps the manager's idea of "active" and chat dispatch's idea of "which
    // agent" the same thing. It only retargets an already-external lane, so the
    // ref write below is what actually switches lanes.
    if (row.ref.kind === "external") selectExternalAgent(row.ref.agentId)
    setRuntimeRef(row.ref)
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
            aria-label={`${t("ariaLabel")}: ${label}`}
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
          {runtimes
            .filter((row) => row.group === "builtin")
            .map((row) => (
              <DropdownMenuRadioItem key={row.key} value={row.key} data-testid="runtime-builtin">
                <BotIcon className="mr-2 size-4" />
                <div className="flex flex-col">
                  <span className="text-sm">{t(row.nameKey ?? "cogniaAgent")}</span>
                  {/* The engine that will ACTUALLY serve this turn. The row used
                      to say "Anthropic SDK sidecar" on every provider. */}
                  <span className="text-[10px] text-muted-foreground">
                    {t(row.descriptionKey ?? "engineClaudeAgentSdk", row.descriptionValues)}
                  </span>
                </div>
              </DropdownMenuRadioItem>
            ))}

          {externalRows.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                {tExternal("externalAgents")}
              </DropdownMenuLabel>
              {externalRows.map((row) => (
                <RuntimeRow key={row.key} row={row} testId={`runtime-external-${agentId(row)}`} />
              ))}
            </>
          ) : null}

          {/* Agents the paired host owns. A separate group, not merged with the
              local rows: a local agent runs where this shell can spawn a
              process, and on a browser that is nowhere, so presenting the two
              as interchangeable would be the misleading part. Only ready,
              enabled configurations appear. The rest are actionable on the
              settings page, not here. */}
          {hostRows.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-[10px] font-normal">
                {tHostConfigs("title")}
              </DropdownMenuLabel>
              {hostRows.map((row) => (
                <RuntimeRow key={row.key} row={row} testId={`runtime-${row.key}`} />
              ))}
            </>
          ) : null}
        </DropdownMenuRadioGroup>

        {/* Three different "no agents to pick" states, each with the action that
            resolves it. They used to collapse into one sentence pointing at a
            Settings page, while the dialog that actually adds an agent sat two
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
        ) : externalRows.length === 0 ? (
          <p className="px-2 py-1.5 text-[10px] text-muted-foreground">{t("externalEmpty")}</p>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => setManageOpen(true)}
          className="gap-2"
          data-testid="runtime-manage-agents"
        >
          <SlidersHorizontalIcon className="size-4" />
          {/* Same dialog either way, but "Manage" reads as housekeeping to
              someone who has nothing to manage yet. */}
          {configuredExternalCount === 0 ? t("addExternalAgent") : tExternal("manageAgents")}
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

/** The agent id behind an external row, for the row's stable test id. */
function agentId(row: AgentRuntimeDescriptor): string {
  return row.ref.kind === "external" ? row.ref.agentId : row.key
}

/** One external or host row. Both carry a name, a protocol badge and a status. */
function RuntimeRow({ row, testId }: { row: AgentRuntimeDescriptor; testId: string }) {
  return (
    <DropdownMenuRadioItem value={row.key} disabled={!!row.blockedReason} data-testid={testId}>
      {row.group === "host" ? (
        <ServerCogIcon className="mr-2 size-4 shrink-0" />
      ) : (
        <BrandIcon
          id={row.brandId ?? row.name ?? row.key}
          label={row.name ?? row.key}
          size={16}
          className="mr-2 shrink-0"
        />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{row.name}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          {row.protocolLabel ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              {row.protocolLabel}
            </Badge>
          ) : null}
          {row.ref.kind === "external" ? <ExternalAgentStatus agentId={row.ref.agentId} /> : null}
        </span>
        {row.blockedReason || row.warning ? (
          <span className="mt-0.5 line-clamp-2 text-[10px] text-amber-600 dark:text-amber-400">
            {row.blockedReason ?? row.warning}
          </span>
        ) : null}
      </div>
    </DropdownMenuRadioItem>
  )
}

/** Live connection state for one row, subscribed per-agent to avoid re-rendering
 *  the whole list on an unrelated agent's status change. */
function ExternalAgentStatus({ agentId }: { agentId: string }) {
  const status = useExternalAgentStore((s) => s.connectionStatus[agentId] ?? "disconnected")
  return <ConnectionStatusBadge status={status} className="h-4 px-1.5 text-[10px]" />
}

export default AgentRuntimeSelector
