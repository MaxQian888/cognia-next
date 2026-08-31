/**
 * External Bridge adapter for the canonical app-session Computer Use API.
 *
 * This module deliberately performs no action translation or coordinate
 * conversion. Both renderer and sidecar paths forward the same revision-bound
 * request shapes to `cognia-automation`.
 */

import { desktop, type CallContext } from "@/lib/automation/client"
import type {
  ActionRequest,
  AppLocator,
  ElementHandle,
  GetAppStateOptions,
  Locator,
  Rect,
} from "@/lib/automation/types"
import { isTauri } from "@/lib/tauri"

export type ComputerUseInput =
  | { operation: "listApps" }
  | {
      operation: "getAppState"
      turnKey: string
      sessionId: string
      locator: AppLocator
      options?: GetAppStateOptions
    }
  | {
      operation: "queryElements"
      sessionId: string
      lineageId: string
      revision: number
      locator: Locator
      limit?: number
    }
  | {
      operation: "expandElement"
      handle: ElementHandle
      continuationToken?: string | null
      limit?: number
    }
  | {
      operation: "performAction"
      turnKey: string
      request: ActionRequest
    }
  | {
      operation: "zoom"
      sessionId: string
      lineageId: string
      revision: number
      region: Rect
    }

export interface ComputerUseOutput {
  ok: boolean
  result?: unknown
  error?: string
}

export async function computerUse(input: ComputerUseInput): Promise<ComputerUseOutput> {
  try {
    const result = isTauri() ? await rendererPath(input) : await sidecarPath(input)
    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function context(turnKey?: string): CallContext {
  return { surface: "mcp", turnKey }
}

async function rendererPath(input: ComputerUseInput): Promise<unknown> {
  switch (input.operation) {
    case "listApps":
      return desktop.listApps(context())
    case "getAppState":
      return desktop.getAppState(
        input.sessionId,
        input.locator,
        input.options,
        context(requireNonEmpty(input.turnKey, "turnKey"))
      )
    case "queryElements":
      return desktop.queryElements(input, input.locator, input.limit, context())
    case "expandElement":
      return desktop.expandElement(input.handle, input.continuationToken, input.limit, context())
    case "performAction":
      return desktop.performAction(
        input.request,
        context(requireNonEmpty(input.turnKey, "turnKey"))
      )
    case "zoom":
      return desktop.zoom(input, input.region, context())
  }
}

let proxyClient: ProxyClient | null = null

async function sidecarPath(input: ComputerUseInput): Promise<unknown> {
  const addr = typeof process !== "undefined" ? process.env?.COGNIA_AUTOMATION_PROXY : undefined
  const token =
    typeof process !== "undefined" ? process.env?.COGNIA_AUTOMATION_PROXY_TOKEN : undefined
  if (!addr || !token) {
    throw new Error(
      "computer_use over MCP requires the Cognia desktop runtime — set " +
        "COGNIA_AUTOMATION_PROXY and COGNIA_AUTOMATION_PROXY_TOKEN"
    )
  }
  if (!proxyClient) {
    proxyClient = await openProxyClient(addr)
  }
  try {
    const response = await proxyClient.send(toEnvelope(input, token))
    if (!response.ok) {
      throw new Error(response.error ?? `${input.operation} failed`)
    }
    return response.result
  } catch (error) {
    proxyClient.close()
    proxyClient = null
    throw error
  }
}

function toEnvelope(input: ComputerUseInput, token: string): ProxyEnvelope {
  const base = { id: cryptoRandomId(), token }
  switch (input.operation) {
    case "listApps":
      return { ...base, command: "desktop_list_apps", args: {} }
    case "getAppState":
      return {
        ...base,
        command: "desktop_get_app_state",
        args: {
          sessionId: input.sessionId,
          turnKey: requireNonEmpty(input.turnKey, "turnKey"),
          locator: input.locator,
          options: input.options ?? {},
        },
      }
    case "queryElements":
      return {
        ...base,
        command: "desktop_query_elements",
        args: {
          sessionId: input.sessionId,
          lineageId: input.lineageId,
          revision: input.revision,
          locator: input.locator,
          limit: input.limit,
        },
      }
    case "expandElement":
      return {
        ...base,
        command: "desktop_expand_element",
        args: {
          handle: input.handle,
          continuationToken: input.continuationToken,
          limit: input.limit,
        },
      }
    case "performAction":
      return {
        ...base,
        command: "desktop_perform_action",
        args: {
          turnKey: requireNonEmpty(input.turnKey, "turnKey"),
          request: input.request,
        },
      }
    case "zoom":
      return {
        ...base,
        command: "desktop_zoom",
        args: {
          sessionId: input.sessionId,
          lineageId: input.lineageId,
          revision: input.revision,
          region: input.region,
        },
      }
  }
}

interface ProxyClient {
  send(envelope: ProxyEnvelope): Promise<ProxyResponse>
  close(): void
}

interface ProxyEnvelope {
  id: string
  token: string
  command: string
  args: Record<string, unknown>
}

interface ProxyResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

async function openProxyClient(addr: string): Promise<ProxyClient> {
  const net = (await import("node:net")) as typeof import("node:net")
  const separator = addr.lastIndexOf(":")
  const host = addr.slice(0, separator)
  const port = Number(addr.slice(separator + 1))
  if (!host || separator < 1 || !Number.isInteger(port)) {
    throw new Error(`invalid COGNIA_AUTOMATION_PROXY value: ${addr}`)
  }
  const socket = net.createConnection({ host, port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.setNoDelay(true)

  const pending = new Map<string, (response: ProxyResponse) => void>()
  let buffer = ""
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          const response = JSON.parse(line) as ProxyResponse
          pending.get(response.id)?.(response)
          pending.delete(response.id)
        } catch {
          // A malformed peer response cannot authorize or complete a call.
        }
      }
      newline = buffer.indexOf("\n")
    }
  })
  const failPending = (message: string) => {
    for (const [id, resolve] of pending) {
      resolve({ id, ok: false, error: message })
    }
    pending.clear()
  }
  socket.on("close", () => failPending("automation_proxy socket closed"))
  socket.on("error", (error) => failPending(`automation_proxy socket error: ${error.message}`))

  return {
    send(envelope) {
      return new Promise((resolve) => {
        pending.set(envelope.id, resolve)
        socket.write(`${JSON.stringify(envelope)}\n`)
      })
    },
    close() {
      socket.destroy()
    },
  }
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must be a non-empty authenticated turn identifier`)
  }
  return value
}

function cryptoRandomId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("node:crypto") as typeof import("node:crypto")).randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

export const __testing__ = {
  resetProxyClient(): void {
    proxyClient?.close()
    proxyClient = null
  },
}
