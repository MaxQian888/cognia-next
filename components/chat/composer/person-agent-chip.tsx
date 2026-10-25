"use client"

/**
 * The composer's agent chip for an org member on a shared Host (P6g).
 *
 * It replaces the runtime selector there: a member's conversation runs as one
 * of the agents the org allows, inside the member's sandbox, and the agent is
 * fixed when the conversation is created. So the chip shows which agent this
 * conversation runs as, what of the member's month is left, and anything that
 * would refuse the next turn. Picking another agent starts a new conversation
 * with it, seeded with a model the org serves for that agent.
 */

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { AlertTriangleIcon, BotIcon, LockIcon, MessageSquareIcon } from "lucide-react"

import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { Badge } from "@/components/ui/badge"
import { CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { findRuntimeById } from "@/lib/ai/agent/external/config/install-catalog"
import {
  personAgentSeed,
  personAllowance,
  personConversationAgent,
  type PersonAgentSeed,
} from "@/lib/chat/person-agent-choice"
import type { PersonAgentsManifest } from "@/lib/platform/host-feature-manifest"
import { cn } from "@/lib/utils"
import type { ChatSession } from "@cognia/agent-config-types"

export interface PersonAgentChipProps {
  session?: Pick<ChatSession, "agentRuntimeId" | "providerOverride" | "model">
  /** The member's agents, as `usePersonAgents` reads them. */
  agents: PersonAgentsManifest
  refresh: () => Promise<void>
  disabled?: boolean
  className?: string
  /** Icon only, for a crowded toolbar; the tooltip carries the words. */
  dense?: boolean
  /** Starts the new conversation; `startNewSession` in the app. */
  onStartConversation: (seed: PersonAgentSeed) => Promise<unknown>
}

function agentName(runtimeId: string): string {
  return findRuntimeById(runtimeId)?.displayName ?? runtimeId
}

export function PersonAgentChip({
  session = {},
  agents,
  refresh,
  disabled,
  className,
  dense,
  onStartConversation,
}: PersonAgentChipProps) {
  const t = useTranslations("personAgents")
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState<string | null>(null)

  // Spend moves with every turn: re-read when the chip appears and on open.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const current = personConversationAgent(session, agents)
  const allowance = personAllowance(agents)
  const tokens = (value: number) => format.number(value, { notation: "compact" })

  const name = current.kind === "agent" ? agentName(current.runtimeId) : t("chat")
  const usedUp = allowance.kind === "used-up"
  const problem = current.kind === "agent" ? current.problem : undefined
  const warn = usedUp || !!problem

  const allowanceLine =
    allowance.kind === "left"
      ? t("allowance.left", {
          left: tokens(allowance.tokens),
          cap: tokens(allowance.monthlyTokens),
        })
      : allowance.kind === "used-up"
        ? t("allowance.usedUp", { cap: tokens(allowance.monthlyTokens) })
        : allowance.kind === "unlimited"
          ? t("allowance.unlimited", { spent: tokens(allowance.spentTokens) })
          : null

  const start = async (runtimeId: string) => {
    const seed = personAgentSeed(agents, runtimeId, session)
    if (!seed) return
    setStarting(runtimeId)
    try {
      await onStartConversation(seed)
      setOpen(false)
    } finally {
      setStarting(null)
    }
  }

  const Icon = current.kind === "agent" ? BotIcon : MessageSquareIcon
  const label = `${t("ariaLabel")}: ${name}`

  return (
    <Tooltip>
      <ResponsivePicker
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) void refresh()
        }}
        title={t("title")}
        description={t("description")}
        align="start"
        contentClassName="w-80"
        testId="person-agent-panel"
        trigger={
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-muted/35 px-2 text-[11px] text-muted-foreground outline-none transition-colors hover:border-border/70 hover:bg-muted/70 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
                className,
                dense && "w-7 justify-center px-0",
                warn && "text-amber-600 dark:text-amber-400"
              )}
              aria-label={label}
              data-testid="person-agent-trigger"
              data-warn={warn || undefined}
            >
              {warn ? (
                <AlertTriangleIcon className="size-3.5 shrink-0" />
              ) : (
                <Icon className="size-3.5 shrink-0" />
              )}
              {dense ? null : <span className="truncate">{name}</span>}
            </button>
          </TooltipTrigger>
        }
      >
        <div className="space-y-1 border-b px-3 py-2 text-xs" data-testid="person-agent-current">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <Icon className="size-3.5" />
            {current.kind === "agent"
              ? current.explicit
                ? t("current.named", { agent: name })
                : t("current.default", { agent: name })
              : t("current.chat")}
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <LockIcon className="size-3" />
            {t("current.locked")}
          </p>
          {problem ? (
            <p className="text-amber-600 dark:text-amber-400" data-testid="person-agent-problem">
              {t(`problem.${problem}`)}
            </p>
          ) : null}
          {allowanceLine ? (
            <p
              className={cn(
                usedUp ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
              )}
              data-testid="person-agent-allowance"
            >
              {allowanceLine}
            </p>
          ) : null}
        </div>
        <CommandList>
          <CommandGroup heading={t("startHeading")}>
            {agents.execution !== "sandboxed" ? (
              <p
                className="px-2 py-1.5 text-xs text-muted-foreground"
                data-testid="person-agent-no-execution"
              >
                {t("noExecution")}
              </p>
            ) : agents.allowedAgents.length === 0 ? (
              <p
                className="px-2 py-1.5 text-xs text-muted-foreground"
                data-testid="person-agent-none"
              >
                {t("noneAllowed")}
              </p>
            ) : (
              agents.allowedAgents.map((agent) => {
                const seed = personAgentSeed(agents, agent.runtimeId, session)
                return (
                  <CommandItem
                    key={agent.runtimeId}
                    value={agent.runtimeId}
                    disabled={!seed || starting !== null || usedUp}
                    onSelect={() => void start(agent.runtimeId)}
                    data-testid={`person-agent-start-${agent.runtimeId}`}
                  >
                    <BotIcon className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      {starting === agent.runtimeId
                        ? t("starting", { agent: agentName(agent.runtimeId) })
                        : agentName(agent.runtimeId)}
                    </span>
                    {agents.defaultAgent === agent.runtimeId ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("badge.default")}
                      </Badge>
                    ) : null}
                    {!agent.available ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("badge.noKey")}
                      </Badge>
                    ) : !seed ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("badge.noModel")}
                      </Badge>
                    ) : null}
                  </CommandItem>
                )
              })
            )}
          </CommandGroup>
        </CommandList>
      </ResponsivePicker>
      <TooltipContent side="top">
        {label}
        {allowanceLine ? ` · ${allowanceLine}` : ""}
      </TooltipContent>
    </Tooltip>
  )
}
