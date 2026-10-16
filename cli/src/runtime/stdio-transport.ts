/**
 * StdioTransport — a {@link Transport} implementation that drives the Node
 * sidecar (`sidecar/claude-host.mjs`) directly over a child process's
 * stdin/stdout, so the standalone CLI reuses the desktop's
 * `runAndCaptureAssistantReply` loop unchanged.
 *
 * It is a Node port of `src-tauri/src/claude/{commands,sidecar}.rs`:
 *   - `call(name, args)` → maps the Tauri command name to a JSON-line written
 *     to the sidecar's stdin (see {@link commandToInbound}).
 *   - `subscribe("claude://message", h)` → every stdout line is JSON-parsed and
 *     forwarded to `h`, exactly as the Rust layer re-emits the raw value.
 *
 * The settings.json hook interception the Rust layer performs is intentionally
 * omitted — permission decisions flow through the loop's `onPermissionRequest`
 * callback instead.
 *
 * `host_rpc` frames are answered here, as the Rust supervisor answers them on
 * the desktop (`crates/cognia-sidecar/src/supervisor.rs`), and never reach
 * subscribers. The standalone CLI has none of the Rust host's registries, so an
 * unsupported method is refused at once rather than left to the sidecar's
 * 30-second timeout.
 */

import readline from "node:readline"

import type { Transport } from "@/lib/tauri/transport-types"

import {
  A2UI_EVENT,
  AGENT_EVENT,
  COMMAND,
  SIDECAR_EVENT,
  commandToInbound,
  type OutboundMessage,
} from "./protocol"

/**
 * Minimal surface of a spawned sidecar the transport needs. `ChildProcess`
 * from `node:child_process` satisfies this; tests pass an in-memory fake.
 */
export interface SidecarHandle {
  stdin: { write(chunk: string): void }
  stdout: NodeJS.ReadableStream
  /** Fires once the child exits. */
  onExit(cb: (code: number | null) => void): void
}

type Handler = (payload: unknown) => void

/** Answers one `host_rpc` method; a throw (or rejection) is sent back as `ok: false`. */
export type HostRpcHandler = (params: unknown) => unknown

/**
 * The methods the standalone CLI host answers. `workspace.portEnv` asks for the
 * workspace's leased ports before a shell spawns: the CLI owns no port
 * allocator, and `null` tells the sidecar to add no port variables.
 */
export const CLI_HOST_RPC_HANDLERS: Readonly<Record<string, HostRpcHandler>> = Object.freeze({
  "workspace.portEnv": () => null,
})

export interface StdioTransportOptions {
  /** `host_rpc` handlers by method. Defaults to {@link CLI_HOST_RPC_HANDLERS}. */
  hostRpc?: Readonly<Record<string, HostRpcHandler>>
}

export class StdioTransport implements Transport {
  private readonly subscribers = new Map<string, Set<Handler>>()
  private ready = false
  private exited = false
  private readonly readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []

  private readonly hostRpc: Readonly<Record<string, HostRpcHandler>>

  constructor(
    private readonly handle: SidecarHandle,
    options: StdioTransportOptions = {}
  ) {
    this.hostRpc = options.hostRpc ?? CLI_HOST_RPC_HANDLERS
    const rl = readline.createInterface({ input: handle.stdout })
    rl.on("line", (line) => this.onLine(line))
    handle.onExit(() => {
      this.exited = true
      // Surface to the loop (mirrors the Rust "sidecar_exited" emit) and fail
      // any pending readiness waiters.
      this.dispatch(SIDECAR_EVENT, { type: "sidecar_exited" })
      const err = new Error("sidecar exited before ready")
      while (this.readyWaiters.length) this.readyWaiters.pop()!.reject(err)
    })
  }

  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
    try {
      if (name === COMMAND.SIDECAR_STATUS) {
        return Promise.resolve({ ready: this.ready } as T)
      }
      const inbound = commandToInbound(name, args ?? {})
      if (inbound === null) return Promise.resolve(undefined as T)
      if (this.exited) return Promise.reject(new Error("sidecar not running"))
      this.handle.stdin.write(JSON.stringify(inbound) + "\n")
      return Promise.resolve(undefined as T)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    let set = this.subscribers.get(event)
    if (!set) {
      set = new Set()
      this.subscribers.set(event, set)
    }
    const h = handler as Handler
    set.add(h)
    let active = true
    return () => {
      if (!active) return // idempotent per the Transport contract
      active = false
      set!.delete(h)
    }
  }

  /**
   * Resolves once the sidecar has emitted its `ready` line; rejects if it exits
   * first or `timeoutMs` elapses. Used by the bootstrap before the first send.
   */
  whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.exited) return Promise.reject(new Error("sidecar exited before ready"))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.readyWaiters.indexOf(entry)
        if (i >= 0) this.readyWaiters.splice(i, 1)
        reject(new Error(`sidecar did not become ready within ${timeoutMs}ms`))
      }, timeoutMs)
      const entry = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      this.readyWaiters.push(entry)
    })
  }

  /** True once the `ready` line has been observed. */
  isReady(): boolean {
    return this.ready
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let value: OutboundMessage
    try {
      value = JSON.parse(trimmed) as OutboundMessage
    } catch {
      // Non-JSON noise on stdout — ignore (matches the Rust reader's warn+skip).
      return
    }
    if (value.type === "host_rpc") {
      void this.answerHostRpc(value)
      return
    }
    if (value.type === "ready" && !this.ready) {
      this.ready = true
      while (this.readyWaiters.length) this.readyWaiters.pop()!.resolve()
    }
    // A2UI dispatches also go to their dedicated channel, mirroring the desktop.
    if (value.type === "a2ui_dispatch") this.dispatch(A2UI_EVENT, value)
    if (value.type === "agent_event") this.dispatch(AGENT_EVENT, value)
    this.dispatch(SIDECAR_EVENT, value)
  }

  /** Run the method's handler and write the `host_rpc_result` the sidecar awaits. */
  private async answerHostRpc(frame: OutboundMessage): Promise<void> {
    const rpcId = frame.rpcId
    if (typeof rpcId !== "string" || !rpcId) return
    const method = typeof frame.method === "string" ? frame.method : ""
    let reply: Record<string, unknown>
    try {
      const handler = Object.hasOwn(this.hostRpc, method) ? this.hostRpc[method] : undefined
      if (!handler) throw new Error(`host_rpc method "${method}" is not available on the CLI host`)
      reply = { type: "host_rpc_result", rpcId, ok: true, result: await handler(frame.params) }
    } catch (err) {
      reply = {
        type: "host_rpc_result",
        rpcId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (this.exited) return
    try {
      this.handle.stdin.write(JSON.stringify(reply) + "\n")
    } catch {
      // The sidecar's stdin closed mid-reply; its own channel teardown rejects the call.
    }
  }

  private dispatch(event: string, payload: unknown): void {
    const set = this.subscribers.get(event)
    if (!set) return
    // Snapshot so a handler that unsubscribes mid-dispatch can't mutate the set
    // we're iterating.
    for (const h of [...set]) {
      try {
        h(payload)
      } catch {
        // A throwing subscriber must not break the read loop.
      }
    }
  }
}
