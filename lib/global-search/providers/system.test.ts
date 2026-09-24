import type { McpServer } from "@cognia/agent-config-types"

import type { PluginRow } from "@/lib/db/plugin-types"
import type { ScheduledTask } from "@/types/scheduler"

import { __resetGlobalSearchCachesForTesting } from "../cache"
import { makeProviderInput, TEST_NOW } from "../testing"
import {
  createMcpServersProvider,
  createPluginsProvider,
  createScheduledTasksProvider,
  withSharedNames,
} from "./system"

jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/scheduler/scheduler-data-source", () => ({
  getSchedulerDataSource: () => ({ listTasks: jest.fn(async () => []) }),
}))

const tasks = [
  {
    id: "k1",
    name: "Nightly backup",
    description: "to s3",
    type: "backup",
    status: "active",
    tags: ["ops"],
    updatedAt: new Date(TEST_NOW),
  },
  { id: "k2", name: "Old sweep", type: "custom", status: "expired", updatedAt: "bad-date" },
] as unknown as ScheduledTask[]

const plugins = [
  {
    id: "p1",
    name: "Clipboard",
    version: "1.2.0",
    source: "builtin",
    type: "frontend",
    enabled: true,
    status: "enabled",
  },
  {
    id: "p2",
    name: "Screenshot",
    version: "0.1.0",
    source: "local",
    type: "hybrid",
    enabled: false,
    status: "disabled",
  },
] as PluginRow[]

const servers = [
  { id: "m1", name: "GitHub MCP", transport: "stdio", enabled: true },
  { id: "m2", name: "Files", transport: "http", enabled: false, pluginId: "p2" },
] as McpServer[]

describe("system providers", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("scheduled tasks: status meta, disabled/expired flagged, tag keywords", async () => {
    const provider = createScheduledTasksProvider({ listTasks: async () => tasks })
    const out = await provider.search(makeProviderInput("backup"))
    expect(out.items[0]).toMatchObject({
      id: "scheduled-task:k1",
      subtitle: "to s3",
      meta: "scheduler.statuses.active",
      extra: { archived: false },
      action: { href: "/scheduler?task=k1" },
    })
    expect(out.items[0]!.timestamp).toBe(TEST_NOW)
    const byTag = await provider.search(makeProviderInput("ops"))
    expect(byTag.items[0]!.id).toBe("scheduled-task:k1")
    const expired = await provider.search(makeProviderInput("sweep"))
    expect(expired.items[0]!.extra?.archived).toBe(true)
    expect(expired.items[0]!.timestamp).toBeUndefined()
  })

  /**
   * Two `demo-heartbeat` tasks ("Paused 18 hours ago" / "Paused Jul 13, 2026")
   * were identical rows in the palette. Same identity line as the scheduler
   * list: kind label + stable source id, only for the shared name.
   */
  it("scheduled tasks: tells same-named tasks apart by kind and source id", async () => {
    const heartbeats = [
      { id: "hb-a", name: "demo-heartbeat", type: "custom", status: "paused" },
      {
        id: "hb-b",
        name: "demo-heartbeat",
        description: "legacy",
        type: "custom",
        status: "paused",
      },
      { id: "solo", name: "demo-report", type: "custom", status: "paused" },
    ] as unknown as ScheduledTask[]
    const provider = createScheduledTasksProvider({ listTasks: async () => heartbeats })
    const out = await provider.search(makeProviderInput("demo"))
    const byId = new Map(out.items.map((item) => [item.id, item]))
    expect(byId.get("scheduled-task:hb-a")!.subtitle).toBe("scheduler.kindFilter.app · hb-a")
    expect(byId.get("scheduled-task:hb-b")!.subtitle).toBe(
      "scheduler.kindFilter.app · hb-b · legacy"
    )
    // A unique name keeps the plain row.
    expect(byId.get("scheduled-task:solo")!.subtitle).toBeUndefined()
    // Shared across the whole list, not just the matched slice.
    const one = await provider.search(makeProviderInput("hb-b"))
    expect(one.items.map((i) => i.id)).toEqual(["scheduled-task:hb-b"])
    expect(one.items[0]!.subtitle).toBe("scheduler.kindFilter.app · hb-b · legacy")
  })

  it("withSharedNames flags only the shared names", () => {
    const rows = withSharedNames([
      { id: "1", name: "a" },
      { id: "2", name: "a" },
      { id: "3", name: "b" },
    ] as unknown as ScheduledTask[])
    expect(rows.map((row) => row.sharesName)).toEqual([true, true, false])
  })

  it("plugins: enabled label, source keyword", async () => {
    const provider = createPluginsProvider({ listPlugins: async () => plugins })
    const out = await provider.search(makeProviderInput("clip"))
    expect(out.items[0]).toMatchObject({
      id: "plugin:p1",
      subtitle: "builtin · v1.2.0",
      meta: "globalSearch.library.enabled",
      extra: { archived: false },
      action: { href: "/plugins?plugin=p1" },
    })
    const bySource = await provider.search(makeProviderInput("local"))
    expect(bySource.items[0]!.meta).toBe("globalSearch.library.disabled")
  })

  it("mcp servers: opens the MCP settings section focused on the server", async () => {
    const provider = createMcpServersProvider({ listMcpServers: async () => servers })
    const out = await provider.search(makeProviderInput("github"))
    expect(out.items[0]).toMatchObject({
      id: "mcp-server:m1",
      subtitle: "stdio",
      action: { type: "open-settings", tab: "mcp", focus: "m1" },
    })
    const byTransport = await provider.search(makeProviderInput("http"))
    expect(byTransport.items[0]!.id).toBe("mcp-server:m2")
    expect(byTransport.items[0]!.extra?.archived).toBe(true)
  })
})
