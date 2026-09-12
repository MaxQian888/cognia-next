import type { AcpMcpServerConfig, ExternalAgentConfig } from "@/types/agent/external-agent"
import { agentInvoke, agentListen, runsExternalAgentProcessesLocally } from "./agent-transport"

export interface OpenCodeV2OwnedService {
  endpoint: string
  headers: Record<string, string>
  close(): Promise<void>
}

export function canProjectOpenCodeV2Mcp(
  config: ExternalAgentConfig,
  hostAvailable = runsExternalAgentProcessesLocally()
): boolean {
  return hostAvailable && (!config.network?.endpoint?.trim() || Boolean(config.process?.command))
}

/** V2 MCP configuration is location-scoped; never write a chat token with mcp.add. */
export function openCodeV2McpConfig(servers: AcpMcpServerConfig[]) {
  const result: Record<string, unknown> = {}
  for (const server of servers) {
    if (!server.name || Object.hasOwn(result, server.name))
      throw new Error("OpenCode MCP server names must be unique")
    if ("command" in server) {
      result[server.name] = {
        type: "local",
        command: [server.command, ...server.args],
        ...(server.env?.length
          ? { environment: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }
          : {}),
        codemode: false,
      }
    } else if ("type" in server && server.type === "http") {
      const url = new URL(server.url)
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("OpenCode MCP requires HTTP(S)")
      result[server.name] = {
        type: "remote",
        url: server.url,
        oauth: false,
        ...(server.headers?.length
          ? { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
          : {}),
        codemode: false,
      }
    } else throw new Error("OpenCode V2 supports only stdio and Streamable HTTP MCP servers")
  }
  return result
}

interface Host {
  invoke: typeof agentInvoke
  listen: typeof agentListen
  available(): boolean
}

/** Start an authenticated loopback child through the existing desktop/CLI process host. */
export async function launchOpenCodeV2Service(
  config: ExternalAgentConfig,
  servers: AcpMcpServerConfig[],
  cwd: string | undefined,
  signal?: AbortSignal,
  host: Host = {
    invoke: agentInvoke,
    listen: agentListen,
    available: runsExternalAgentProcessesLocally,
  }
): Promise<OpenCodeV2OwnedService> {
  if (!host.available())
    throw new Error("Cognia MCP projection for OpenCode requires a local process host")
  if (config.network?.endpoint && !config.process?.command)
    throw new Error(
      "An existing OpenCode endpoint cannot receive session-owned MCP servers; configure a local OpenCode executable"
    )
  signal?.throwIfAborted()
  const id = `opencode-v2-${crypto.randomUUID()}`
  const password = crypto.randomUUID()
  const base = config.process?.env?.OPENCODE_CONFIG_CONTENT
  let inherited: Record<string, unknown> = {}
  if (base) {
    try {
      inherited = JSON.parse(base)
    } catch {
      throw new Error("Invalid OpenCode inline configuration")
    }
    if (!inherited || typeof inherited !== "object" || Array.isArray(inherited))
      throw new Error("Invalid OpenCode inline configuration")
  }
  const previousMcp =
    inherited.mcp && typeof inherited.mcp === "object"
      ? (inherited.mcp as Record<string, unknown>)
      : {}
  const inline = {
    ...inherited,
    mcp: {
      ...previousMcp,
      servers: {
        ...((previousMcp.servers as Record<string, unknown>) ?? {}),
        ...openCodeV2McpConfig(servers),
      },
    },
  }
  const listeners: Array<() => void> = []
  let spawned = false
  let exited = false
  let finished = false
  let resolve!: (endpoint: string) => void
  let reject!: (error: Error) => void
  const ready = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  void ready.catch(() => undefined)
  const buffers = { stdout: "", stderr: "" }
  const abort = () => reject(new DOMException("OpenCode startup aborted", "AbortError"))
  const timeout = setTimeout(
    () => reject(new Error("OpenCode service startup timed out")),
    config.process?.startupTimeout ?? 15_000
  )
  const cleanup = () => {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
    for (const off of listeners.splice(0)) off()
  }
  const close = async () => {
    if (spawned && !exited) {
      await host.invoke("kill_external_agent", { agentId: id })
      exited = true
    }
    cleanup()
  }
  const output = (stream: keyof typeof buffers) => (event: { agentId: string; data: string }) => {
    if (event.agentId !== id || finished) return
    buffers[stream] = (buffers[stream] + event.data).slice(-8192)
    const match = buffers[stream].match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)
    if (match) {
      finished = true
      resolve(match[1])
    }
  }
  try {
    listeners.push(await host.listen("external-agent://stdout", output("stdout")))
    listeners.push(await host.listen("external-agent://stderr", output("stderr")))
    listeners.push(
      await host.listen<{ agentId: string }>("external-agent://exit", (event) => {
        if (event.agentId === id) {
          exited = true
          reject(new Error("OpenCode service exited before becoming ready"))
        }
      })
    )
    signal?.addEventListener("abort", abort, { once: true })
    signal?.throwIfAborted()
    await host.invoke("spawn_external_agent", {
      config: {
        id,
        command: config.process?.command ?? "opencode",
        args: ["serve", ...(config.process?.args ?? []), "--hostname=127.0.0.1", "--port=0"],
        cwd,
        env: {
          ...config.process?.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(inline),
          OPENCODE_SERVER_PASSWORD: password,
        },
      },
    })
    spawned = true
    const endpoint = await ready
    signal?.throwIfAborted()
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
    return { endpoint, headers: { Authorization: `Basic ${btoa(`opencode:${password}`)}` }, close }
  } catch (error) {
    await close().catch(() => undefined)
    cleanup()
    throw error
  }
}
