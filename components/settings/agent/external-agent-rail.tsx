"use client"

/**
 * ExternalAgentRail — the unified left rail for the external-agents page.
 *
 * One scroll region holds three groups: the pinned "All agents" overview
 * (the landing view), the configured agent rows (brand icon + mini readiness
 * pipeline + quick connect), and the non-agent destinations (global settings,
 * delegation, preset gallery, runtimes, host). Previously the gallery was the
 * landing view and the two row types were interleaved with identical
 * anatomy, so neither fleet state nor "where am I" was readable at a glance.
 */

import {
  Boxes,
  LayoutDashboard,
  Loader2,
  Plus,
  Power,
  PowerOff,
  Route,
  ServerCog,
  Settings2,
  Sparkles,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BrandIcon } from "@/components/icons/brand-icon"
import { cn } from "@/lib/utils"
import { getPresetDisplayInfo, isFromPreset } from "@/lib/ai/agent/external/presets"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import { AgentReadinessDots } from "./agent-readiness-pipeline"

/** What the right-hand detail pane is currently showing. */
export type AgentSettingsView =
  | { kind: "overview" }
  | { kind: "gallery" }
  | { kind: "global" }
  | { kind: "delegation" }
  | { kind: "runtimes" }
  | { kind: "host" }
  | { kind: "agent"; id: string }

function RailItem({
  icon: Icon,
  label,
  active,
  onClick,
  dataTestId,
}: {
  icon: typeof Settings2
  label: string
  active: boolean
  onClick: () => void
  dataTestId: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-pressed={active}
      data-testid={dataTestId}
      className={cn(
        "h-auto w-full justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-accent/50",
        active && "bg-accent font-medium text-accent-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </Button>
  )
}

export function ExternalAgentRail({
  agents,
  readinessById,
  view,
  enabled,
  onViewChange,
  onNewAgent,
  onConnect,
  onDisconnect,
  isConnecting,
}: {
  agents: LifecycleExternalAgentConfig[]
  readinessById: ReadonlyMap<string, AgentReadiness>
  view: AgentSettingsView
  enabled: boolean
  onViewChange: (view: AgentSettingsView) => void
  onNewAgent: () => void
  onConnect: (agentId: string) => void
  onDisconnect: (agentId: string) => void
  isConnecting: (agentId: string) => boolean
}) {
  const t = useTranslations("externalAgent.settings")
  const tRuntimes = useTranslations("externalAgent.runtimes")
  const tHostConfigs = useTranslations("externalAgent.hostConfigs")

  return (
    <aside
      className="shrink-0 space-y-4 @3xl/agents-pane:w-60 @3xl/agents-pane:overflow-y-auto @3xl/agents-pane:pr-1"
      data-testid="external-agent-rail"
    >
      {/* Fleet section — overview first: "are my agents alive" is the most
          frequent question, so it is the landing view rather than the store. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 px-2">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("configuredAgents")}
          </p>
          {agents.length > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {agents.length}
            </Badge>
          )}
        </div>
        <RailItem
          icon={LayoutDashboard}
          label={t("allAgents")}
          active={view.kind === "overview"}
          onClick={() => onViewChange({ kind: "overview" })}
          dataTestId="nav-all-agents"
        />
        <div className="space-y-0.5">
          {agents.map((agent) => {
            const readiness = readinessById.get(agent.id)
            const connected = readiness?.state === "connected"
            const connecting = isConnecting(agent.id)
            // Blocked and deliberately-disabled agents cannot accept a
            // connection — the power button would only produce an error toast.
            const cannotConnect = readiness?.state === "blocked" || readiness?.state === "disabled"
            const presetId = isFromPreset(agent)
            const fromPresetName = presetId ? getPresetDisplayInfo(presetId)?.name : undefined
            return (
              <div
                key={agent.id}
                className={cn(
                  "group flex items-center gap-0.5 rounded-md",
                  view.kind === "agent" && view.id === agent.id && "bg-accent"
                )}
              >
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onViewChange({ kind: "agent", id: agent.id })}
                  aria-pressed={view.kind === "agent" && view.id === agent.id}
                  data-testid={`agent-row-${agent.id}`}
                  // The old row burned a second text line on this; the mini
                  // pipeline carries it now — keep it one hover away.
                  title={readiness?.blockReason ?? `${agent.protocol} · ${agent.transport}`}
                  className={cn(
                    "h-auto min-w-0 flex-1 justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-accent/50",
                    view.kind === "agent" &&
                      view.id === agent.id &&
                      "font-medium text-accent-foreground"
                  )}
                >
                  <BrandIcon id={presetId ?? agent.name} label={agent.name} size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{agent.name}</span>
                      {fromPresetName && (
                        <Badge
                          variant="outline"
                          className="h-4 shrink-0 px-1 text-[9px] font-normal"
                          data-testid={`agent-from-preset-${agent.id}`}
                        >
                          {fromPresetName}
                        </Badge>
                      )}
                    </span>
                    {readiness ? (
                      <AgentReadinessDots readiness={readiness} className="mt-1" />
                    ) : null}
                  </span>
                </Button>
                {/* Connect without leaving the list — the most frequent
                    action was previously two clicks deep. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={
                    connected
                      ? t("quickDisconnect", { name: agent.name })
                      : t("quickConnect", { name: agent.name })
                  }
                  data-testid={`agent-power-${agent.id}`}
                  disabled={!enabled || connecting || (!connected && cannotConnect)}
                  onClick={() => (connected ? onDisconnect(agent.id) : onConnect(agent.id))}
                >
                  {connecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : connected ? (
                    <PowerOff className="h-3.5 w-3.5" />
                  ) : (
                    <Power className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            )
          })}
          <Button
            type="button"
            variant="ghost"
            onClick={onNewAgent}
            disabled={!enabled}
            data-testid="nav-new-agent"
            className="h-auto w-full justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal text-muted-foreground hover:bg-accent/50"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span className="truncate">{t("addAgent")}</span>
          </Button>
        </div>
      </div>

      {/* Configuration destinations — a different object type than agent
          instances, grouped under their own header so the two never blend. */}
      <nav className="space-y-1">
        <p className="px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t("navConfigure")}
        </p>
        <RailItem
          icon={Settings2}
          label={t("globalSettings")}
          active={view.kind === "global"}
          onClick={() => onViewChange({ kind: "global" })}
          dataTestId="nav-global-settings"
        />
        <RailItem
          icon={Route}
          label={t("delegation.title")}
          active={view.kind === "delegation"}
          onClick={() => onViewChange({ kind: "delegation" })}
          dataTestId="nav-delegation"
        />
        <RailItem
          icon={Sparkles}
          label={t("quickStartTitle")}
          active={view.kind === "gallery"}
          onClick={() => onViewChange({ kind: "gallery" })}
          dataTestId="nav-quick-start"
        />
        <RailItem
          icon={Boxes}
          label={tRuntimes("title")}
          active={view.kind === "runtimes"}
          onClick={() => onViewChange({ kind: "runtimes" })}
          dataTestId="nav-runtimes"
        />
        {/* Agents the paired host owns. A rail entry rather than a section
            stacked under the local list, because the two answer different
            questions — "what have I configured here" versus "what can
            actually run over there" — and interleaving them made a
            browser's unrunnable local agents look equivalent to the host's
            runnable ones. */}
        <RailItem
          icon={ServerCog}
          label={tHostConfigs("title")}
          active={view.kind === "host"}
          onClick={() => onViewChange({ kind: "host" })}
          dataTestId="nav-host-configs"
        />
      </nav>
    </aside>
  )
}
