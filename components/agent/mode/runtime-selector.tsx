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
 *
 * The panel is a `ResponsivePicker` over cmdk rather than a `DropdownMenu`, for
 * two reasons that only show up once someone actually configures agents. A
 * radio menu has no search, and this list is builtin + every local agent +
 * every configuration the paired host owns, which is a scroll of a dozen
 * near-identical rows on any real setup. And a menu anchored to a chip at the
 * bottom of a 375px screen opens into the keyboard, where the drawer branch of
 * the picker does not.
 *
 * cmdk owns highlight and filtering, so `aria-selected` on a row means "the
 * keyboard is on this one", NOT "this is the lane". The lane is `aria-current`
 * plus the tick, which is the same split `PickerRow` writes down.
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
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { ResponsivePicker, PickerCheck } from "@/components/shared/responsive-picker"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/sonner"
import { BrandIcon } from "@/components/icons/brand-icon"
import { ConnectionStatusBadge } from "@/components/agent/external-agent/connection-status-badge"
import { useAgentConnectionStatus } from "@/hooks/agent/use-agent-connection-status"
import { AgentCredentialBadge } from "@/components/agent/external-agent/credential-status-badge"
import { ExternalAgentManager } from "@/components/agent/external-agent/manager"
import { cn } from "@/lib/utils"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { selectExternalAgent } from "@/lib/agent/external-agent-selection"
import { ensureExternalAgentReady } from "@/lib/agent/ensure-external-agent-ready"
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
  /**
   * The row this chip sits on has run out of width.
   *
   * The glyph-only form used to be decided by the runtime KIND: the builtin
   * lane never spelled its name, on any screen, because the label had once
   * cost a crowded status line the room it needed. That traded a permanent
   * loss for an occasional one, and on a wide composer it left an unlabelled
   * icon beside a stretch of empty toolbar. The measurement the toolbar
   * already takes for its own layout decides it instead, so the name is there
   * whenever there is room to put it.
   */
  dense?: boolean
}

export function AgentRuntimeSelector({
  className,
  dense = false,
  disabled,
  providerId,
  sessionId,
}: Props) {
  const t = useTranslations("agentRuntime")
  const tExternal = useTranslations("externalAgent")
  const tHostConfigs = useTranslations("externalAgent.hostConfigs")
  const [open, setOpen] = useState(false)
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

  const { runtimes, selected, externalEnabled, configuredExternalCount } = useAgentRuntimeCatalog(
    providerId,
    sessionId
  )

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
  // Off the default lane the agent's NAME is the whole point of the chip, so it
  // is spelled out at any width. On the builtin lane the label is worth the
  // room only when there is room: it is the one value the chip can never be
  // wrong about, and it was what pushed the composer's status line into its
  // neighbours. The tooltip and the aria-label carry the wording in both
  // states, so nothing is only visual.
  const namesAChoice = !onBuiltin || !dense

  const handleValueChange = (next: string) => {
    const row = runtimes.find((candidate) => candidate.key === next)
    // cmdk will not fire `onSelect` for a disabled item, but the guard stays:
    // it is the same guard the menu had, and it is what makes a blocked row
    // inert to a programmatic select too.
    if (!row || row.blockedReason) return
    setOpen(false)
    // `selectExternalAgent` writes the external-agent store too, which is what
    // keeps the manager's idea of "active" and chat dispatch's idea of "which
    // agent" the same thing. It only retargets an already-external lane, so the
    // ref write below is what actually switches lanes.
    if (row.ref.kind === "external") {
      selectExternalAgent(row.ref.agentId)
      // Picking an agent says the next turn runs there, so it has to be able
      // to. A configured agent that was never connected used to be selectable
      // with nothing saying the lane could not dispatch, and the first send
      // reached the manager's adapter map and came back `Agent not found`.
      //
      // Not awaited, because the menu closes now. But the answer is not
      // dropped either: the report is recorded against the agent, and the one
      // place that draws those reports is the Manage Agents panel, which is
      // not where this user is standing. A failure here has to say so here.
      // `unknown-agent` is the exception, and only because the fallback effect
      // above is already moving the lane back to the built-in runtime.
      void ensureExternalAgentReady(row.ref.agentId).then((readiness) => {
        if (readiness.ok || readiness.reason === "unknown-agent") return
        toast.error(tExternal("failure.connect"), { description: readiness.detail })
      })
    }
    setRuntimeRef(row.ref)
  }

  /**
   * A filter earns its row only once the list is long enough to scroll.
   *
   * Builtin alone, or builtin plus one agent, fits in view and a search box
   * there is a control that can only ever hide something.
   */
  const showSearch = runtimes.length >= SEARCH_THRESHOLD

  return (
    <>
      {/*
        `TooltipTrigger` sits INSIDE the picker's trigger slot, so the picker's
        trigger clones it and it clones the button: one DOM node carrying both
        behaviours. `TooltipContent` is a sibling of the picker because Radix
        pairs them through context, not through the tree.
      */}
      <Tooltip>
        <ResponsivePicker
          open={open}
          onOpenChange={setOpen}
          title={t("label")}
          description={t("tooltip")}
          align="start"
          side="top"
          contentClassName="w-80"
          testId="agent-runtime-panel"
          trigger={
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-muted/35 px-2 text-[11px] text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                  className,
                  // Glyph-only on the default runtime: square it up so it reads
                  // as a peer of the other icon-sized status controls rather
                  // than a chip with a missing label. After `className` so the
                  // host's chip padding doesn't re-inflate the square.
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
              </button>
            </TooltipTrigger>
          }
        >
          {showSearch ? <CommandInput placeholder={t("searchPlaceholder")} /> : null}
          <CommandList>
            <CommandEmpty>{t("noMatches")}</CommandEmpty>

            <CommandGroup heading={t("label")}>
              {runtimes
                .filter((row) => row.group === "builtin")
                .map((row) => (
                  <RuntimeOption
                    key={row.key}
                    row={row}
                    active={value === row.key}
                    onSelect={handleValueChange}
                    testId="runtime-builtin"
                    media={<BotIcon className="size-4 shrink-0" />}
                    name={t(row.nameKey ?? "cogniaAgent")}
                    // The engine that will ACTUALLY serve this turn. The row
                    // used to say "Anthropic SDK sidecar" on every provider.
                    detail={t(row.descriptionKey ?? "engineClaudeAgentSdk", row.descriptionValues)}
                  />
                ))}
            </CommandGroup>

            {externalRows.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading={tExternal("externalAgents")}>
                  {externalRows.map((row) => (
                    <RuntimeOption
                      key={row.key}
                      row={row}
                      active={value === row.key}
                      onSelect={handleValueChange}
                      testId={`runtime-external-${agentId(row)}`}
                    />
                  ))}
                </CommandGroup>
              </>
            ) : null}

            {/* Agents the paired host owns. A separate group, not merged with
                the local rows: a local agent runs where this shell can spawn a
                process, and on a browser that is nowhere, so presenting the two
                as interchangeable would be the misleading part. Only ready,
                enabled configurations appear. The rest are actionable on the
                settings page, not here. */}
            {hostRows.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading={tHostConfigs("title")}>
                  {hostRows.map((row) => (
                    <RuntimeOption
                      key={row.key}
                      row={row}
                      active={value === row.key}
                      onSelect={handleValueChange}
                      testId={`runtime-${row.key}`}
                    />
                  ))}
                </CommandGroup>
              </>
            ) : null}

            <CommandSeparator />
            {/*
              `forceMount` on the actions, because a search that matches no
              agent is exactly when the user needs the one that adds an agent.
              Without it the filter would hide the only way out of an empty
              list.
            */}
            <CommandGroup forceMount>
              {/* Three different "no agents to pick" states, each with the
                  action that resolves it. They used to collapse into one
                  sentence pointing at a Settings page, while the dialog that
                  actually adds an agent sat two rows below, unmentioned. */}
              {!externalEnabled ? (
                <>
                  <p className="px-2 pt-1.5 text-[10px] text-muted-foreground">
                    {t("externalTurnedOff")}
                  </p>
                  <CommandItem
                    forceMount
                    value="enable-external"
                    onSelect={() => {
                      setOpen(false)
                      setExternalEnabled(true)
                    }}
                    className="gap-2"
                    data-testid="runtime-enable-external"
                  >
                    <PowerIcon className="size-4" />
                    {t("enableExternal")}
                  </CommandItem>
                </>
              ) : externalRows.length === 0 ? (
                <p className="px-2 py-1.5 text-[10px] text-muted-foreground">
                  {t("externalEmpty")}
                </p>
              ) : null}

              <CommandItem
                forceMount
                value="manage-agents"
                onSelect={() => {
                  // Close FIRST. On a phone this picker is a Drawer, and a
                  // Drawer unmounts its children, so a dialog opened before the
                  // close would be torn down by it.
                  setOpen(false)
                  setManageOpen(true)
                }}
                className="gap-2"
                data-testid="runtime-manage-agents"
              >
                <SlidersHorizontalIcon className="size-4" />
                {/* Same dialog either way, but "Manage" reads as housekeeping
                    to someone who has nothing to manage yet. */}
                {configuredExternalCount === 0 ? t("addExternalAgent") : tExternal("manageAgents")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </ResponsivePicker>
        <TooltipContent side="top">{t("tooltip")}</TooltipContent>
      </Tooltip>

      {/* Mounted OUTSIDE the picker, not inside it: the row that opens this
          closes the picker, and on a phone that unmounts the picker's subtree. */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{tExternal("manageAgents")}</DialogTitle>
          </DialogHeader>
          <ExternalAgentManager className="min-h-0 flex-1" />
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Above this many rows the list stops fitting in view and a filter starts
 * paying for itself. Builtin plus a couple of agents does not.
 */
const SEARCH_THRESHOLD = 5

/** The agent id behind an external row, for the row's stable test id. */
function agentId(row: AgentRuntimeDescriptor): string {
  return row.ref.kind === "external" ? row.ref.agentId : row.key
}

/**
 * One selectable runtime: the built-in lane, a local agent, or a host
 * configuration.
 *
 * `media`, `name` and `detail` are overridable because the built-in row is not
 * an agent record. It has a translated name and an engine line rather than a
 * brand mark, a protocol badge and a connection status. Everything else about
 * the row is identical, so it is one component rather than two that drift.
 *
 * `aria-current`, not `aria-selected`: cmdk owns the latter and uses it for
 * keyboard highlight, so a row would claim to be the active lane merely
 * because the arrow keys were resting on it.
 */
function RuntimeOption({
  row,
  active,
  onSelect,
  testId,
  media,
  name,
  detail,
}: {
  row: AgentRuntimeDescriptor
  active: boolean
  onSelect: (key: string) => void
  testId: string
  media?: React.ReactNode
  name?: string
  detail?: string
}) {
  const blocked = !!row.blockedReason
  const displayName = name ?? row.name ?? row.key
  return (
    <CommandItem
      // Every string the row shows that identifies it, so typing the agent's
      // name, its lane or its protocol all find it.
      value={`${row.key} ${displayName} ${row.protocolLabel ?? ""}`}
      disabled={blocked}
      onSelect={() => onSelect(row.key)}
      data-testid={testId}
      data-value={row.key}
      aria-current={active || undefined}
      // cmdk only emits `aria-disabled` when disabled. Stating both keeps a row
      // that is merely warning distinguishable from one that is refusing.
      aria-disabled={blocked}
      className="items-start gap-2 px-2 py-2"
    >
      {media ??
        (row.group === "host" ? (
          <ServerCogIcon className="size-4 shrink-0" />
        ) : (
          <BrandIcon
            id={row.brandId ?? row.name ?? row.key}
            label={row.name ?? row.key}
            size={16}
            className="shrink-0"
          />
        ))}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{displayName}</span>
        {detail ? <span className="text-[10px] text-muted-foreground">{detail}</span> : null}
        <span className="mt-0.5 flex flex-wrap items-center gap-1 empty:hidden">
          {row.protocolLabel ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              {row.protocolLabel}
            </Badge>
          ) : null}
          {row.ref.kind === "external" ? <ExternalAgentStatus agentId={row.ref.agentId} /> : null}
          {/* Signed in, or connected to nothing? The probe already ran on
              connect; this is the first place it is shown where the choice is
              actually made. Self-hides for an agent with no credential probe. */}
          {row.ref.kind === "external" ? (
            <AgentCredentialBadge agentId={row.ref.agentId} className="h-4 px-1.5" />
          ) : null}
        </span>
        {row.blockedReason || row.warning ? (
          <span className="mt-0.5 line-clamp-2 text-[10px] text-amber-600 dark:text-amber-400">
            {row.blockedReason ?? row.warning}
          </span>
        ) : null}
      </div>
      <PickerCheck active={active} />
    </CommandItem>
  )
}

/** Live connection state for one row, subscribed per-agent to avoid re-rendering
 *  the whole list on an unrelated agent's status change. */
function ExternalAgentStatus({ agentId }: { agentId: string }) {
  const status = useAgentConnectionStatus(agentId)
  return <ConnectionStatusBadge status={status} className="h-4 px-1.5 text-[10px]" />
}

export default AgentRuntimeSelector
