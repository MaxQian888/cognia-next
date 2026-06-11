/**
 * Sidecar-side client for the orchestration proxy (Thread D4).
 *
 * The External Bridge orchestration handlers (`agent_dispatch` / `team_run` /
 * `plugin_tool_invoke`) need renderer-resident entry points that the Node MCP
 * sidecar cannot reach. When running inside the Cognia desktop sidecar, the
 * Rust side bound a dedicated `orchestration_proxy` TCP port and passed its
 * address + shared-secret token through the env (`COGNIA_ORCH_PROXY` /
 * `COGNIA_ORCH_PROXY_TOKEN`). This module opens that socket, forwards a JSON
 * envelope, and the Rust proxy bounces it to the renderer and streams the
 * result back. Mirrors the `computer-use.ts` automation-proxy client.
 *
 * When the env is unset (standalone npm plugin, web/mobile — no Cognia desktop
 * runtime), `proxyToRenderer` returns a structured desktop-required error so
 * the external agent sees a clear reason instead of a silent failure.
 */

/** Minimum shape every orchestration handler output shares. */
interface OrchestrationOutput {
  ok: boolean
  error?: string
}

const DESKTOP_REQUIRED =
  "Orchestration tools require the Cognia desktop renderer — set COGNIA_ORCH_PROXY + " +
  "COGNIA_ORCH_PROXY_TOKEN in the sidecar env. Standalone mode is not supported."

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

interface ProxyClient {
  send(envelope: ProxyEnvelope): Promise<ProxyResponse>
  close(): void
}

let proxyClient: ProxyClient | null = null

/**
 * Forward one orchestration command to the renderer over the proxy socket.
 *
 * On success returns the renderer handler's output (`T`). When the proxy env
 * is missing, or the socket / proxy errors, returns a `{ ok: false, error }`
 * envelope shaped like `T` so callers get a uniform failure.
 */
export async function proxyToRenderer<T extends OrchestrationOutput>(
  command: string,
  input: Record<string, unknown>
): Promise<T> {
  const addr = typeof process !== "undefined" ? process.env?.COGNIA_ORCH_PROXY : undefined
  const token = typeof process !== "undefined" ? process.env?.COGNIA_ORCH_PROXY_TOKEN : undefined

  if (!addr || !token) {
    return { ok: false, error: DESKTOP_REQUIRED } as T
  }

  try {
    if (!proxyClient) {
      proxyClient = await openProxyClient(addr)
    }
    const resp = await proxyClient.send({
      id: cryptoRandomId(),
      token,
      command,
      args: input,
    })
    if (!resp.ok) {
      return { ok: false, error: resp.error ?? "orchestration proxy error" } as T
    }
    // The renderer handler's full output object is carried in `result`.
    return resp.result as T
  } catch (err) {
    // Reset the cached client so the next call retries from scratch (e.g. after
    // a sidecar / renderer restart on the Rust side).
    proxyClient = null
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T
  }
}

async function openProxyClient(addr: string): Promise<ProxyClient> {
  // Late-import `node:net` so renderer / test bundles never pull the Node-only
  // module at parse time (this path only runs in the sidecar).
  const net = (await import("node:net")) as typeof import("node:net")
  const [host, portStr] = addr.split(":")
  const port = Number(portStr)
  if (!host || !Number.isInteger(port)) {
    throw new Error(`invalid COGNIA_ORCH_PROXY value: ${addr}`)
  }

  const socket = net.createConnection({ host, port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  socket.setNoDelay(true)

  // Each call gets its own pending entry keyed by id — concurrent orchestration
  // calls multiplex over the single connection.
  const pending = new Map<string, (resp: ProxyResponse) => void>()
  let buffer = ""
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let nl = buffer.indexOf("\n")
    while (nl >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.length > 0) {
        try {
          const resp = JSON.parse(line) as ProxyResponse
          const cb = pending.get(resp.id)
          if (cb) {
            pending.delete(resp.id)
            cb(resp)
          }
        } catch {
          // Discard malformed lines — the Rust side never emits them.
        }
      }
      nl = buffer.indexOf("\n")
    }
  })
  const failAll = (message: string) => {
    for (const cb of pending.values()) {
      cb({ id: "", ok: false, error: message })
    }
    pending.clear()
  }
  socket.on("close", () => failAll("orchestration_proxy socket closed"))
  socket.on("error", (err) => failAll(`orchestration_proxy socket error: ${err.message}`))

  return {
    send(envelope) {
      return new Promise<ProxyResponse>((resolve) => {
        pending.set(envelope.id, resolve)
        socket.write(JSON.stringify(envelope) + "\n")
      })
    },
    close() {
      try {
        socket.destroy()
      } catch {
        // already closed
      }
    },
  }
}

function cryptoRandomId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cryptoMod = require("node:crypto") as typeof import("node:crypto")
    return cryptoMod.randomUUID()
  } catch {
    return Math.random().toString(16).slice(2) + Date.now().toString(16)
  }
}

/** Exposed for tests so the cached connection can be reset between cases. */
export const __testing__ = {
  resetProxyClient(): void {
    if (proxyClient) {
      try {
        proxyClient.close()
      } catch {
        // ignore — best-effort cleanup
      }
    }
    proxyClient = null
  },
}
