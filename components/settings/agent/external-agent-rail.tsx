"use client"

/**
 * ExternalAgentRail — the master column of the external-agents
 * master/detail layout.
 *
 * One scroll region: the pinned "All agents" overview entry (the landing
 * view), then the configured fleet grouped by readiness — needs attention
 * (blocked/error/connecting), connected, inactive (off/disabled) — so a
 * broken agent is never buried mid-list. Each row carries the mini
 * readiness dots and a quick-connect button. The add row and the CONFIGURE
 * group of non-agent destinations close the list.
 *
 * At the stacked pane tier (<560px, see `SettingsListDetail`) the whole
 * rail collapses into a compact Select picker — the same job the Sheet
 * trigger does for nav rails in `SettingsMasterDetail`.
 */

import {
  Boxes,
  LayoutDashboard,
  Loader2,
  Plus,
  Power,
  PowerOff,
  Route,
  Search,
  ServerCog,
  Settings2,
  Sparkles,
} from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { BrandIcon } from "@/components/icons/brand-icon"
import { cn } from "@/lib/utils"
import { getPresetDisplayInfo, isFromPreset } from "@/lib/ai/agent/external/presets"
import type { AgentReadiness, AgentReadinessState } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import { useSettingsListDensity } from "@/components/settings/common/settings-master-detail"
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

type AgentGroupId = "attention" | "connected" | "inactive"

const GROUP_ORDER: AgentGroupId[] = ["attention", "connected", "inactive"]

/**
 * Readiness state → rail group. "connecting" sits with attention rather than
 * inactive: it is a transitional state worth watching, and a connect that
 * stalls is indistinguishable from a failure until it resolves.
 */
function groupForState(state: AgentReadinessState | undefined): AgentGroupId {
  if (state === "connected") return "connected"
  if (state === "blocked" || state === "error" || state === "connecting") return "attention"
  return "inactive"
}

/** Select values are flat strings; agent rows carry their id after a prefix. */
function viewKey(view: AgentSettingsView): string {
  return view.kind === "agent" ? `agent:${view.id}` : view.kind
}

function parseViewKey(key: string): AgentSettingsView {
  if (key.startsWith("agent:")) return { kind: "agent", id: key.slice(6) }
  return { kind: key } as AgentSettingsView
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

function GroupLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <p className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
      {count != null ? <span className="tabular-nums">{count}</span> : null}
    </p>
  )
}

function AgentRow({
  agent,
  readiness,
  active,
  connecting,
  disabled,
  onSelect,
  onPower,
}: {
  agent: LifecycleExternalAgentConfig
  readiness: AgentReadiness | undefined
  active: boolean
  connecting: boolean
  /** Master switch off — the row still selects, the power button does not. */
  disabled: boolean
  onSelect: () => void
  onPower: () => void
}) {
  const t = useTranslations("externalAgent.settings")
  const presetId = isFromPreset(agent)
  const fromPresetName = presetId ? getPresetDisplayInfo(presetId)?.name : undefined
  const connected = readiness?.state === "connected"
  // Blocked and deliberately-disabled agents cannot accept a connection —
  // the power button would only produce an error toast.
  const cannotConnect = readiness?.state === "blocked" || readiness?.state === "disabled"

  return (
    <div className={cn("group flex items-center gap-0.5 rounded-md", active && "bg-accent")}>
      <Button
        type="button"
        variant="ghost"
        onClick={onSelect}
        aria-pressed={active}
        data-testid={`agent-row-${agent.id}`}
        // The row stays single-line for scan density; the block reason rides
        // the hover title instead of a second text line.
        title={readiness?.blockReason ?? `${agent.protocol} · ${agent.transport}`}
        className={cn(
          "h-auto min-w-0 flex-1 justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-accent/50",
          active && "font-medium text-accent-foreground"
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
          {readiness ? <AgentReadinessDots readiness={readiness} className="mt-1" /> : null}
        </span>
      </Button>
      {/* Connect without leaving the list — the most frequent action should
          not be two clicks deep. */}
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
        disabled={disabled || connecting || (!connected && cannotConnect)}
        onClick={onPower}
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

  const q = query.trim().toLowerCase()
  const filtered = agents.filter(
    (agent) =>
      !q || agent.name.toLowerCase().includes(q) || agent.description?.toLowerCase().includes(q)
  )
  const grouped = GROUP_ORDER.map((id) => ({
    id,
    label:
      id === "connected"
        ? tReadiness("states.connected")
        : id === "attention"
          ? t("railGroupAttention")
          : t("railGroupInactive"),
    agents: filtered.filter((agent) => groupForState(readinessById.get(agent.id)?.state) === id),
  })).filter((group) => group.agents.length > 0)

  // Stacked tier (<560px pane): the auto-height first row cannot hold a
  // scrolling list, so destinations compress into a picker — same content,
  // one row tall.
  if (density === "stacked") {
    return (
      <div className="rounded-lg border p-2" data-testid="external-agent-rail">
        <Select value={viewKey(view)} onValueChange={(key) => onViewChange(parseViewKey(key))}>
          <SelectTrigger
            className="h-8 text-xs"
            aria-label={t("railPickerLabel")}
            data-testid="nav-picker"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="overview">{t("allAgents")}</SelectItem>
            {agents.length > 0 ? <SelectSeparator /> : null}
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={`agent:${agent.id}`}>
                {agent.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            {configureItems.map((item) => (
              <SelectItem key={viewKey(item.view)} value={viewKey(item.view)}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  return (
    <aside
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border"
      data-testid="external-agent-rail"
    >
      {/* Fleet filter — pinned outside the scroll region. */}
      <div className="shrink-0 border-b p-2">
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {/* The overview stays pinned above the groups — "are my agents alive"
            is the landing question, not another fleet row. */}
        <RailItem
          icon={LayoutDashboard}
          label={t("allAgents")}
          active={view.kind === "overview"}
          onClick={() => onViewChange({ kind: "overview" })}
          dataTestId="nav-all-agents"
        />

        <div className="pt-2">
          {grouped.map((group) => (
            <div key={group.id} className="pt-3 first:pt-0">
              <GroupLabel count={group.agents.length}>{group.label}</GroupLabel>
              <div className="space-y-0.5">
                {group.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    readiness={readinessById.get(agent.id)}
                    active={view.kind === "agent" && view.id === agent.id}
                    connecting={isConnecting(agent.id)}
                    disabled={!enabled}
                    onSelect={() => onViewChange({ kind: "agent", id: agent.id })}
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
            <p className="px-2 py-3 text-xs text-muted-foreground">{t("railSearchEmpty")}</p>
          ) : null}
        </div>

        <Button
          type="button"
          variant="ghost"
          onClick={onNewAgent}
          disabled={!enabled}
          data-testid="nav-new-agent"
          className="mt-1 h-auto w-full justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal text-muted-foreground hover:bg-accent/50"
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("addAgent")}</span>
        </Button>

        {/* Configuration destinations — a different object type than agent
            instances, grouped under their own header so the two never blend. */}
        <nav className="pt-4">
          <GroupLabel>{t("navConfigure")}</GroupLabel>
          <div className="space-y-0.5">
            {configureItems.map((item) => (
              <RailItem
                key={viewKey(item.view)}
                icon={item.icon}
                label={item.label}
                active={view.kind === item.view.kind}
                onClick={() => onViewChange(item.view)}
                dataTestId={item.testId}
              />
            ))}
          </div>
        </nav>
      </div>
    </aside>
  )
}
