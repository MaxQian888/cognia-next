"use client"

/**
 * ExternalAgentRail — the master column of the external-agents
 * master/detail layout.
 *
 * One scroll region: the pinned "All agents" overview entry (the landing
 * view), then the configured fleet, grouped one of two ways:
 *
 *   - **by readiness** — needs attention (blocked/error/connecting), connected,
 *     inactive (off/disabled) — so a broken agent is never buried mid-list;
 *   - **by runtime** — every configuration of one runtime together (ADR-0216),
 *     so a read-only Codex and its workspace-write copy sit side by side.
 *
 * Each row carries the mini readiness dots, the traits that set it apart from
 * the other configurations of its runtime, and a quick-connect button. The add
 * row and the CONFIGURE group of non-agent destinations close the list.
 *
 * At the stacked pane tier (<560px, see `SettingsListDetail`) the list and the
 * detail take turns owning the pane — the same list→detail push the provider
 * settings use: the full list (search, groups, quick connect) fills the pane,
 * choosing a destination shows its detail under a back bar, and the back bar
 * returns to the list.
 */

import { Spinner } from "@/components/ui/spinner"
import {
  ArrowLeft,
  Boxes,
  LayoutDashboard,
  Plus,
  Power,
  PowerOff,
  Route,
  Search,
  ServerCog,
  Settings2,
  Sparkles,
} from "lucide-react"
import { useId, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { BrandIcon } from "@/components/icons/brand-icon"
import { cn } from "@/lib/utils"
import { getPresetDisplayInfo, isFromPreset } from "@/lib/ai/agent/external/config/presets"
import { runtimeFamilyKey } from "@/lib/ai/agent/external/config/instance-family"
import type { AgentReadiness, AgentReadinessState } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import { useSettingsListDensity } from "@/components/settings/common/settings-master-detail"
import {
  InstanceTraitChips,
  type InstanceTrait,
} from "@/components/agent/external-agent/instance-traits"
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

/** At the stacked tier: is the list or the detail on screen? */
export type AgentRailStackedView = "list" | "detail"

export type AgentRailGroupBy = "readiness" | "runtime"

type ReadinessGroupId = "attention" | "connected" | "inactive"

const READINESS_GROUP_ORDER: ReadinessGroupId[] = ["attention", "connected", "inactive"]

/**
 * Readiness state → rail group. "connecting" sits with attention rather than
 * inactive: it is a transitional state worth watching, and a connect that
 * stalls is indistinguishable from a failure until it resolves.
 */
function groupForState(state: AgentReadinessState | undefined): ReadinessGroupId {
  if (state === "connected") return "connected"
  if (state === "blocked" || state === "error" || state === "connecting") return "attention"
  return "inactive"
}

function viewKey(view: AgentSettingsView): string {
  return view.kind === "agent" ? `agent:${view.id}` : view.kind
}

/** The runtime's display name for a family header. */
function familyLabel(agent: LifecycleExternalAgentConfig): string {
  const presetId = isFromPreset(agent)
  const preset = presetId ? getPresetDisplayInfo(presetId)?.name : undefined
  if (preset) return preset
  if (agent.transport === "stdio" && agent.process?.command) {
    return runtimeFamilyKey(agent).replace(/^command:/, "")
  }
  return agent.protocol
}

function matchesQuery(agent: LifecycleExternalAgentConfig, q: string): boolean {
  if (!q) return true
  const presetId = isFromPreset(agent)
  const haystack = [
    agent.name,
    agent.description,
    presetId,
    presetId ? getPresetDisplayInfo(presetId)?.name : undefined,
    agent.protocol,
    agent.process?.command,
    agent.network?.endpoint,
  ]
  return haystack.some((value) => value?.toLowerCase().includes(q))
}

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
      aria-current={active ? "page" : undefined}
      data-testid={dataTestId}
      className={cn(
        "touch-hit h-auto w-full justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-accent/50",
        active && "bg-accent font-medium text-accent-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </Button>
  )
}

function GroupLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <p className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <span className="truncate">{children}</span>
      {count != null ? <span className="tabular-nums">{count}</span> : null}
    </p>
  )
}

function AgentRow({
  agent,
  readiness,
  traits,
  showPresetBadge,
  active,
  connecting,
  disabled,
  onSelect,
  onPower,
}: {
  agent: LifecycleExternalAgentConfig
  readiness: AgentReadiness | undefined
  traits: readonly InstanceTrait[]
  /** Runtime grouping names the runtime in the header; the row need not repeat it. */
  showPresetBadge: boolean
  active: boolean
  connecting: boolean
  /** Master switch off — the row still selects, the power button does not. */
  disabled: boolean
  onSelect: () => void
  onPower: () => void
}) {
  const t = useTranslations("externalAgent.settings")
  const reasonId = useId()
  const presetId = isFromPreset(agent)
  const fromPresetName = presetId ? getPresetDisplayInfo(presetId)?.name : undefined
  const connected = readiness?.state === "connected"
  // Blocked and deliberately-disabled agents cannot accept a connection —
  // the power button would only produce an error toast.
  const cannotConnect = readiness?.state === "blocked" || readiness?.state === "disabled"
  const blockReason = readiness?.blockReason ?? null

  return (
    <div className={cn("group flex items-center gap-0.5 rounded-md", active && "bg-accent")}>
      <Button
        type="button"
        variant="ghost"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        aria-describedby={blockReason ? reasonId : undefined}
        data-testid={`agent-row-${agent.id}`}
        // The hover title stays for a mouse; keyboard and screen-reader users
        // get the same reason through `aria-describedby`.
        title={blockReason ?? `${agent.protocol} · ${agent.transport}`}
        className={cn(
          "touch-hit h-auto min-w-0 flex-1 justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-accent/50",
          active && "font-medium text-accent-foreground"
        )}
      >
        <BrandIcon id={presetId ?? agent.name} label={agent.name} size={20} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{agent.name}</span>
            {showPresetBadge && fromPresetName && (
              <Badge
                variant="outline"
                className="h-4 shrink-0 px-1 text-[9px] font-normal"
                data-testid={`agent-from-preset-${agent.id}`}
              >
                {fromPresetName}
              </Badge>
            )}
          </span>
          <InstanceTraitChips traits={traits} max={2} className="mt-0.5" />
          {readiness ? <AgentReadinessDots readiness={readiness} className="mt-1" /> : null}
          {blockReason ? (
            <span id={reasonId} className="sr-only">
              {blockReason}
            </span>
          ) : null}
        </span>
      </Button>
      {/* Connect without leaving the list — the most frequent action should
          not be two clicks deep. */}
      <Button
        variant="ghost"
        size="icon"
        className="touch-hit h-8 w-8 shrink-0"
        aria-label={
          connected
            ? t("quickDisconnect", { name: agent.name })
            : t("quickConnect", { name: agent.name })
        }
        data-testid={`agent-power-${agent.id}`}
        disabled={disabled || connecting || (!connected && cannotConnect)}
        onClick={onPower}
      >
        {connecting ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : connected ? (
          <PowerOff className="h-3.5 w-3.5" />
        ) : (
          <Power className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  )
}

export function ExternalAgentRail({
  agents,
  readinessById,
  traitsById,
  view,
  enabled,
  groupBy,
  onGroupByChange,
  stackedView,
  onStackedViewChange,
  onViewChange,
  onNewAgent,
  onConnect,
  onDisconnect,
  isConnecting,
}: {
  agents: LifecycleExternalAgentConfig[]
  readinessById: ReadonlyMap<string, AgentReadiness>
  /** What sets each agent apart from the other configurations of its runtime. */
  traitsById: ReadonlyMap<string, readonly InstanceTrait[]>
  view: AgentSettingsView
  enabled: boolean
  groupBy: AgentRailGroupBy
  onGroupByChange: (groupBy: AgentRailGroupBy) => void
  stackedView: AgentRailStackedView
  onStackedViewChange: (view: AgentRailStackedView) => void
  onViewChange: (view: AgentSettingsView) => void
  onNewAgent: () => void
  onConnect: (agentId: string) => void
  onDisconnect: (agentId: string) => void
  isConnecting: (agentId: string) => boolean
}) {
  const t = useTranslations("externalAgent.settings")
  const tReadiness = useTranslations("externalAgent.readiness")
  const tRuntimes = useTranslations("externalAgent.runtimes")
  const tHostConfigs = useTranslations("externalAgent.hostConfigs")
  const density = useSettingsListDensity()
  const [query, setQuery] = useState("")

  const configureItems: {
    view: AgentSettingsView
    icon: typeof Settings2
    label: string
    testId: string
  }[] = [
    {
      view: { kind: "global" },
      icon: Settings2,
      label: t("globalSettings"),
      testId: "nav-global-settings",
    },
    {
      view: { kind: "delegation" },
      icon: Route,
      label: t("delegation.title"),
      testId: "nav-delegation",
    },
    {
      view: { kind: "gallery" },
      icon: Sparkles,
      label: t("quickStartTitle"),
      testId: "nav-quick-start",
    },
    { view: { kind: "runtimes" }, icon: Boxes, label: tRuntimes("title"), testId: "nav-runtimes" },
    {
      view: { kind: "host" },
      icon: ServerCog,
      label: tHostConfigs("title"),
      testId: "nav-host-configs",
    },
  ]

  const stacked = density === "stacked"
  // Choosing anything at the stacked tier hands the pane to its detail.
  const choose = (next: AgentSettingsView) => {
    onViewChange(next)
    if (stacked) onStackedViewChange("detail")
  }

  const q = query.trim().toLowerCase()
  const filtered = agents.filter((agent) => matchesQuery(agent, q))
  const groups: { id: string; label: string; agents: LifecycleExternalAgentConfig[] }[] =
    groupBy === "runtime"
      ? Array.from(
          filtered
            .reduce((families, agent) => {
              const key = runtimeFamilyKey(agent)
              const family = families.get(key)
              if (family) family.agents.push(agent)
              else families.set(key, { id: key, label: familyLabel(agent), agents: [agent] })
              return families
            }, new Map<string, { id: string; label: string; agents: LifecycleExternalAgentConfig[] }>())
            .values()
        )
      : READINESS_GROUP_ORDER.map((id) => ({
          id,
          label:
            id === "connected"
              ? tReadiness("states.connected")
              : id === "attention"
                ? t("railGroupAttention")
                : t("railGroupInactive"),
          agents: filtered.filter(
            (agent) => groupForState(readinessById.get(agent.id)?.state) === id
          ),
        })).filter((group) => group.agents.length > 0)

  if (stacked && stackedView === "detail") {
    const current =
      view.kind === "agent"
        ? (agents.find((agent) => agent.id === view.id)?.name ?? t("allAgents"))
        : view.kind === "overview"
          ? t("allAgents")
          : (configureItems.find((item) => item.view.kind === view.kind)?.label ?? t("allAgents"))
    return (
      <div className="flex min-w-0 items-center gap-2" data-testid="external-agent-rail-bar">
        <Button
          variant="ghost"
          size="sm"
          className="touch-target shrink-0 gap-1.5 pl-1"
          onClick={() => onStackedViewChange("list")}
          data-testid="external-agent-rail-back"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("railBackToList")}
        </Button>
        <span className="min-w-0 truncate text-sm font-medium" aria-current="page">
          {current}
        </span>
      </div>
    )
  }

  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border",
        // At the stacked tier the frame reserves a bar row above the detail
        // row; the list owns both while it is the one on screen.
        stacked && "row-span-2"
      )}
      aria-label={t("railLabel")}
      data-testid="external-agent-rail"
      data-stacked-view={stacked ? "list" : undefined}
    >
      {/* Fleet filter and grouping — pinned outside the scroll region. */}
      <div className="shrink-0 space-y-2 border-b p-2">
        <div className="relative">
          <Search
            aria-hidden
            className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("railSearchPlaceholder")}
            aria-label={t("railSearchPlaceholder")}
            className="h-8 pl-8 text-xs"
            data-testid="agent-search"
          />
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={groupBy}
          onValueChange={(value) => {
            // A single toggle group reports "" when the active item is clicked
            // again; grouping always has one answer.
            if (value === "readiness" || value === "runtime") onGroupByChange(value)
          }}
          aria-label={t("railGroupByLabel")}
          className="w-full"
          data-testid="agent-rail-group-by"
        >
          <ToggleGroupItem value="readiness" className="flex-1 text-xs">
            {t("railGroupByReadiness")}
          </ToggleGroupItem>
          <ToggleGroupItem value="runtime" className="flex-1 text-xs">
            {t("railGroupByRuntime")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {/* The overview stays pinned above the groups — "are my agents alive"
            is the landing question, not another fleet row. */}
        <RailItem
          icon={LayoutDashboard}
          label={t("allAgents")}
          active={view.kind === "overview"}
          onClick={() => choose({ kind: "overview" })}
          dataTestId="nav-all-agents"
        />

        <div className="pt-2">
          {groups.map((group) => (
            <div
              key={group.id}
              className="pt-3 first:pt-0"
              role="group"
              aria-label={group.label}
              data-testid={`agent-rail-group-${group.id}`}
            >
              <GroupLabel count={group.agents.length}>{group.label}</GroupLabel>
              <div className="space-y-0.5">
                {group.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    readiness={readinessById.get(agent.id)}
                    traits={traitsById.get(agent.id) ?? []}
                    showPresetBadge={groupBy === "readiness"}
                    active={view.kind === "agent" && view.id === agent.id}
                    connecting={isConnecting(agent.id)}
                    disabled={!enabled}
                    onSelect={() => choose({ kind: "agent", id: agent.id })}
                    onPower={() =>
                      readinessById.get(agent.id)?.state === "connected"
                        ? onDisconnect(agent.id)
                        : onConnect(agent.id)
                    }
                  />
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && q ? (
            <p className="px-2 py-3 text-xs text-muted-foreground" role="status">
              {t("railSearchEmpty")}
            </p>
          ) : null}
        </div>

        <Button
          type="button"
          variant="ghost"
          onClick={onNewAgent}
          disabled={!enabled}
          data-testid="nav-new-agent"
          className="touch-hit mt-1 h-auto w-full justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal text-muted-foreground hover:bg-accent/50"
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("addAgent")}</span>
        </Button>

        {/* Configuration destinations — a different object type than agent
            instances, grouped under their own header so the two never blend. */}
        <nav className="pt-4" aria-label={t("navConfigure")}>
          <GroupLabel>{t("navConfigure")}</GroupLabel>
          <div className="space-y-0.5">
            {configureItems.map((item) => (
              <RailItem
                key={viewKey(item.view)}
                icon={item.icon}
                label={item.label}
                active={view.kind === item.view.kind}
                onClick={() => choose(item.view)}
                dataTestId={item.testId}
              />
            ))}
          </div>
        </nav>
      </div>
    </aside>
  )
}
