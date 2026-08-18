/**
 * System (ADR-0129): scheduled tasks, installed plugins and MCP servers. Each
 * opens its management surface. Scheduled tasks go through the scheduler data
 * source (host-neutral, ADR-0128); the rest read Dexie via the list-provider
 * cache. Inbox conversations and contacts live in `./inbox`.
 */

import type { McpServer } from "@cognia/agent-config-types"
import { CalendarClockIcon, PlugIcon, ServerCogIcon } from "lucide-react"

import type { PluginRow } from "@/lib/db/plugin-types"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listPlugins } from "@/lib/db/plugins"
import { getSchedulerDataSource } from "@/lib/scheduler/scheduler-data-source"
import type { ScheduledTask } from "@/types/scheduler"
import { createListProvider } from "./list-provider"

export const SCHEDULED_TASKS_PROVIDER_ID = "builtin.scheduled-tasks"
export const PLUGINS_PROVIDER_ID = "builtin.plugins"
export const MCP_SERVERS_PROVIDER_ID = "builtin.mcp-servers"

export interface SystemProviderDeps {
  listTasks: () => Promise<ScheduledTask[]>
  listPlugins: () => Promise<PluginRow[]>
  listMcpServers: () => Promise<McpServer[]>
}

function toEpoch(value: Date | number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export function createScheduledTasksProvider(deps: Pick<SystemProviderDeps, "listTasks">) {
  return createListProvider<ScheduledTask>({
    id: SCHEDULED_TASKS_PROVIDER_ID,
    kind: "scheduled-task",
    load: () => deps.listTasks(),
    getTitle: (task) => task.name,
    getSecondary: (task) => task.description,
    getKeywords: (task) => [task.id, task.type, ...(task.tags ?? [])],
    getTimestamp: (task) => toEpoch(task.updatedAt),
    toItem: ({ row, match }, ctx) => ({
      id: `scheduled-task:${row.id}`,
      kind: "scheduled-task",
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.description?.trim() || undefined,
      meta: ctx.t(`scheduler.statuses.${row.status}`),
      icon: { lucide: CalendarClockIcon },
      score: match.score,
      timestamp: toEpoch(row.updatedAt),
      extra: { archived: row.status === "disabled" || row.status === "expired" },
      action: { type: "navigate", href: `/scheduler?task=${encodeURIComponent(row.id)}` },
    }),
  })
}

export function createPluginsProvider(deps: Pick<SystemProviderDeps, "listPlugins">) {
  return createListProvider<PluginRow>({
    id: PLUGINS_PROVIDER_ID,
    kind: "plugin",
    load: () => deps.listPlugins(),
    getTitle: (p) => p.name,
    getKeywords: (p) => [p.id, p.source, p.type],
    toItem: ({ row, match }, ctx) => ({
      id: `plugin:${row.id}`,
      kind: "plugin",
      title: row.name,
      titlePositions: match.positions,
      subtitle: `${row.source} · v${row.version}`,
      meta: row.enabled
        ? ctx.t("globalSearch.library.enabled")
        : ctx.t("globalSearch.library.disabled"),
      icon: { lucide: PlugIcon },
      score: match.score,
      extra: { archived: !row.enabled },
      action: { type: "navigate", href: `/plugins?plugin=${encodeURIComponent(row.id)}` },
    }),
  })
}

export function createMcpServersProvider(deps: Pick<SystemProviderDeps, "listMcpServers">) {
  return createListProvider<McpServer>({
    id: MCP_SERVERS_PROVIDER_ID,
    kind: "mcp-server",
    load: () => deps.listMcpServers(),
    getTitle: (s) => s.name,
    getKeywords: (s) => [s.id, s.transport, s.pluginId ?? ""],
    toItem: ({ row, match }, ctx) => ({
      id: `mcp-server:${row.id}`,
      kind: "mcp-server",
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.transport,
      meta: row.enabled
        ? ctx.t("globalSearch.library.enabled")
        : ctx.t("globalSearch.library.disabled"),
      icon: { lucide: ServerCogIcon },
      score: match.score,
      extra: { archived: !row.enabled },
      action: { type: "open-settings", tab: "mcp", focus: row.id },
    }),
  })
}

export const scheduledTasksProvider = createScheduledTasksProvider({
  listTasks: () => getSchedulerDataSource().listTasks(),
})
export const pluginsProvider = createPluginsProvider({ listPlugins })
export const mcpServersProvider = createMcpServersProvider({ listMcpServers })
