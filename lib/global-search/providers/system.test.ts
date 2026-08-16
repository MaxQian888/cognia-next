import type { ChatSession, McpServer } from "@cognia/agent-config-types"

import type { PluginRow } from "@/lib/db/plugin-types"
import type { ScheduledTask } from "@/types/scheduler"

import { __resetGlobalSearchCachesForTesting } from "../cache"
import { makeProviderInput, makeTestContext, TEST_NOW } from "../testing"
import {
  createMcpServersProvider,
  createPluginsProvider,
  createScheduledTasksProvider,
  inboxProvider,
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

const sessions = [
  {
    id: "s1",
    title: "Ops room",
    updatedAt: TEST_NOW,
    platformBinding: { platform: "lark", conversationKey: "lark:oc_1" },
  },
  {
    id: "s2",
    title: "",
    updatedAt: TEST_NOW - 1,
    platformBinding: { platform: "slack", conversationKey: "slack:C1" },
  },
  { id: "s3", title: "Plain chat", updatedAt: TEST_NOW },
] as unknown as ChatSession[]

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

  it("inbox: only platform-bound sessions, falls back to the conversation key as title", async () => {
    const ctx = makeTestContext({ sessions })
    const out = await inboxProvider.search(makeProviderInput("ops", { ctx }))
    expect(out.items.map((i) => i.id)).toEqual(["inbox-conversation:s1"])
    expect(out.items[0]).toMatchObject({
      subtitle: "lark:oc_1",
      meta: "lark",
      action: { type: "navigate", href: "/inbox/c?key=lark%3Aoc_1" },
    })
    const byKey = await inboxProvider.search(makeProviderInput("slack", { ctx }))
    expect(byKey.items[0]!.title).toBe("slack:C1")
    const plain = await inboxProvider.search(makeProviderInput("plain", { ctx }))
    expect(plain.items).toEqual([])
  })
})
