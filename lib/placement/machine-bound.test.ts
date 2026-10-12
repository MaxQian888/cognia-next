import type { ScheduledTask } from "@/types/scheduler"
import type { PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import {
  classifyBotInstallation,
  classifyConnectorInstance,
  classifyScheduledTask,
  collectKeyringRefs,
  describeRemoteSchedulerHost,
  isLocalPath,
  isLoopbackUrl,
  managedTaskOwner,
  type MachineBoundContext,
} from "./machine-bound"

const headless: MachineBoundContext = { target: describeRemoteSchedulerHost("headless") }

function task(overrides: Partial<ScheduledTask> = {}) {
  return {
    type: "chat" as ScheduledTask["type"],
    trigger: { type: "cron" as const, cronExpression: "0 9 * * *" },
    payload: { prompt: "Summarise the inbox" },
    ...overrides,
  }
}

describe("classifyScheduledTask", () => {
  it("lets a plain chat schedule move to a headless host", () => {
    expect(classifyScheduledTask(task(), headless)).toEqual({ movable: true, reasons: [] })
  })

  it("keeps an OS-promoted task on its machine", () => {
    const verdict = classifyScheduledTask(
      task({
        promotion: { systemTaskId: "s", token: "t", promotedAt: new Date(0) },
      }),
      headless
    )
    expect(verdict.movable).toBe(false)
    expect(verdict.reasons).toEqual([{ kind: "os-promotion" }])
  })

  it("keeps work about this machine's own data here, even when the host could run the type", () => {
    expect(classifyScheduledTask(task({ type: "backup", payload: {} }), headless).reasons).toEqual([
      { kind: "machine-maintenance", taskType: "backup" },
    ])
  })

  it("never moves a task another item owns on its own", () => {
    expect(
      classifyScheduledTask(task({ type: "bot", payload: { installationId: "b" } }), headless)
        .reasons
    ).toContainEqual({ kind: "managed-by", manager: "bot-installation" })
    expect(
      classifyScheduledTask(task({ type: "connection:outbound:send", payload: {} }), headless)
        .reasons
    ).toContainEqual({ kind: "managed-by", manager: "connector-instance" })
  })

  it("reports a type the target host cannot run, with what it lacks", () => {
    const verdict = classifyScheduledTask(task(), { target: describeRemoteSchedulerHost("web") })
    expect(verdict.reasons).toContainEqual(
      expect.objectContaining({ kind: "task-type-unsupported", taskType: "chat" })
    )
  })

  it("keeps a task listening for this machine's own events", () => {
    const verdict = classifyScheduledTask(
      task({ trigger: { type: "event", eventType: "session:completed" } }),
      headless
    )
    expect(verdict.reasons).toEqual([{ kind: "local-event", eventType: "session:completed" }])
    // Connector and custom events are emitted wherever they are asked for.
    expect(
      classifyScheduledTask(task({ trigger: { type: "event", eventType: "custom" } }), headless)
        .movable
    ).toBe(true)
  })

  it("lists every local path, stdio MCP server, keychain secret and workspace root", () => {
    const context: MachineBoundContext = {
      ...headless,
      mcpServer: (id) =>
        id === "fs"
          ? { name: "Filesystem", transport: "stdio" }
          : { name: "Search", transport: "http" },
      projectRoots: (id) => (id === "p1" ? ["/Users/me/repo", "relative"] : []),
    }
    const verdict = classifyScheduledTask(
      task({
        type: "agent",
        projectId: "p1",
        payload: {
          prompt: "x",
          characterId: "c",
          additionalDirectories: ["/Users/me/notes", "docs"],
          mcpServerIds: ["fs", "web"],
          appendSystemPrompt: "keyring:github:token",
        },
      }),
      context
    )
    expect(verdict.movable).toBe(false)
    expect(verdict.reasons).toEqual([
      { kind: "local-path", field: "additionalDirectories", path: "/Users/me/notes" },
      { kind: "stdio-mcp", serverId: "fs", name: "Filesystem" },
      { kind: "keyring-reference", ref: "keyring:github:token" },
      { kind: "local-project-root", projectId: "p1", path: "/Users/me/repo" },
    ])
  })

  it("lets paths inside a workspace that travels with its repository go (ADR-0224 A11)", () => {
    const verdict = classifyScheduledTask(
      task({
        type: "agent",
        projectId: "p1",
        payload: { prompt: "x", cwd: "/Users/me/repo/web", additionalDirectories: ["/tmp/x"] },
      }),
      {
        ...headless,
        projectRoots: () => [],
        portablePath: (path) => path.startsWith("/Users/me/repo"),
      }
    )
    expect(verdict.reasons).toEqual([
      { kind: "local-path", field: "additionalDirectories", path: "/tmp/x" },
    ])
  })

  it("keeps a background command, which always names a directory here", () => {
    const verdict = classifyScheduledTask(
      task({ type: "background-command", payload: { command: "make", cwd: "C:\\work" } }),
      headless
    )
    expect(verdict.reasons).toContainEqual({ kind: "local-path", field: "cwd", path: "C:\\work" })
  })
})

describe("classifyBotInstallation", () => {
  const schedule: PluginBotTriggerDef = { id: "daily", kind: "schedule", cron: "0 9 * * *" }
  const desktop: PluginBotTriggerDef = {
    id: "on-pet",
    kind: "event",
    source: "desktop",
    types: ["pet.poked"],
  }

  it("moves a Bot whose triggers a host can receive", () => {
    expect(classifyBotInstallation({ config: {} }, [schedule])).toEqual({
      movable: true,
      reasons: [],
    })
  })

  it("keeps a Bot that listens for desktop or pet events", () => {
    expect(classifyBotInstallation({ config: {} }, [schedule, desktop]).reasons).toEqual([
      { kind: "desktop-trigger", triggerId: "on-pet" },
    ])
  })

  it("keeps a Bot configured with a local folder or bound to a local workspace", () => {
    const verdict = classifyBotInstallation(
      { config: { path: "~/inbox", label: "x" }, projectId: "p" },
      [schedule],
      { projectRoots: () => ["/srv/app"] }
    )
    expect(verdict.reasons).toEqual([
      { kind: "local-path", field: "path", path: "~/inbox" },
      { kind: "local-project-root", projectId: "p", path: "/srv/app" },
    ])
  })
})

describe("classifyConnectorInstance", () => {
  it("moves a long-polling or socket connector", () => {
    expect(
      classifyConnectorInstance({ transportMode: "longpoll", settings: { botName: "x" } }).movable
    ).toBe(true)
  })

  it("keeps a webhook connector, which receives on this machine's public URL", () => {
    expect(
      classifyConnectorInstance({
        transportMode: "webhook",
        publicUrl: "https://me.example",
        settings: {},
      }).reasons
    ).toEqual([{ kind: "webhook-endpoint", publicUrl: "https://me.example" }])
  })

  it("keeps a connector that talks to a service on this machine's loopback", () => {
    expect(
      classifyConnectorInstance({
        transportMode: "forward-ws",
        settings: { wsUrl: "ws://127.0.0.1:3001", mediaDir: "/tmp/qq" },
      }).reasons
    ).toEqual([
      { kind: "loopback-endpoint", field: "wsUrl", url: "ws://127.0.0.1:3001" },
      { kind: "local-path", field: "mediaDir", path: "/tmp/qq" },
    ])
  })
})

describe("helpers", () => {
  it("names the item a Bot's or connector's own task belongs to", () => {
    expect(managedTaskOwner("bot")).toBe("bot-installation")
    expect(managedTaskOwner("connection:outbound:send")).toBe("connector-instance")
    expect(managedTaskOwner("chat")).toBeUndefined()
  })

  it("tells a local path from a name", () => {
    expect(isLocalPath("/a")).toBe(true)
    expect(isLocalPath("~")).toBe(true)
    expect(isLocalPath("D:/x")).toBe(true)
    expect(isLocalPath("\\\\server\\share")).toBe(true)
    expect(isLocalPath("relative/dir")).toBe(false)
    expect(isLocalPath("https://x")).toBe(false)
  })

  it("recognises loopback URLs only", () => {
    expect(isLoopbackUrl("http://localhost:8080")).toBe(true)
    expect(isLoopbackUrl("ws://[::1]:9")).toBe(true)
    expect(isLoopbackUrl("http://127.4.5.6")).toBe(true)
    expect(isLoopbackUrl("https://api.telegram.org")).toBe(false)
    expect(isLoopbackUrl("not a url")).toBe(false)
  })

  it("finds keychain references at any depth", () => {
    expect([
      ...collectKeyringRefs({ a: ["keyring:ns:k", { b: "keyring:x:y" }], c: "keyring:" }),
    ]).toEqual(["keyring:ns:k", "keyring:x:y"])
  })
})
