/**
 * Mock V2 headless server for mobile E2E tests.
 *
 * Implements the slice of the desktop server contract the Capacitor mobile
 * shell talks to during pairing + steady-state:
 *
 *   POST /api/v1/auth/pair        — exchange a pair JWT for a long-lived device JWT
 *   GET  /api/v1/whoami           — server identity / fingerprint attestation
 *   GET  /api/v1/status           — connection health probe
 *   GET  /api/v1/events           — SSE stream for connection-state pushes
 *   POST /api/v1/sidecar/call     — generic RPC (idempotency-aware)
 *   POST /api/v1/_rpc/:command    — outbound-queue drain target (CompanionTransport.call);
 *                                   mirrors the Rust dispatcher's 404 on commands outside
 *                                   MOBILE_OUTBOUND_COMMANDS, captures every call
 *   GET  /__control/rpc-calls     — captured _rpc calls, for spec assertions over HTTP
 *                                   (the shared instance lives in the globalSetup process,
 *                                   so worker-side specs can't touch the object directly)
 *
 * Lifecycle mirrors `tests/e2e/connectors/telegram-mock-server.ts`. Each
 * test starts the server, configures failure modes / canned responses,
 * runs assertions, and stops the server. The Playwright globalSetup hook
 * boots one shared instance for specs that just need a server reachable
 * at a known URL — those specs may use the shared port (see
 * `tests/e2e/global-setup.ts`).
 */

// Importing lazily so the file parses even when express isn't installed
// in environments that only need the type surface.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createExpressApp = () => require("express")() as import("express").Application

import type { Server } from "http"
import { MOBILE_OUTBOUND_COMMANDS } from "../../../lib/db/mobile-outbound-types"

export interface RpcCapture {
  command: string
  body: unknown
  idempotencyKey: string | null
}

export interface PairResponseBody {
  device_id: string
  device_jwt: string
  server_version: string
}

export interface PairRequestPayload {
  pair_jwt: string
  device_label: string
  device_platform: string
  device_pubkey: string
  app_version: string
}

export type PairScenario =
  | { kind: "ok"; body?: Partial<PairResponseBody>; fingerprint?: string }
  | { kind: "invalid-jwt" } // 403 with bad-jwt error
  | { kind: "expired"; status?: number; message?: string } // 401 with token-expired error
  | { kind: "fingerprint-mismatch"; bodyFingerprint: string; pinnedFingerprint: string }
  | { kind: "server-error"; status: number; message: string }
  | { kind: "unreachable" } // close the socket without responding

export type ConnectionStateEvent =
  | {
      type: "connection-state"
      state: "connected" | "reconnecting" | "offline" | "unauthenticated"
    }
  | { type: "sidecar-status"; status: "online" | "degraded" | "offline" }

export interface MockV2Server {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string

  /** Pair scenario for the next POST /api/v1/auth/pair call. */
  setPairScenario(scenario: PairScenario): void
  /** Whoami response body for fingerprint attestation. */
  setWhoamiFingerprint(fingerprint: string | null): void
  /** Whether GET /api/v1/status returns 200 (online) or 401 (expired). */
  setStatusResponse(status: "ok" | "expired" | "offline"): void
  /** Push an event to all current SSE subscribers. */
  pushEvent(event: ConnectionStateEvent): void
  /** Force-close every SSE connection (simulates network drop). */
  closeAllStreams(): void

  /** Wait until a single POST /api/v1/auth/pair has been received. */
  waitForPair(timeoutMs?: number): Promise<PairRequestPayload>
  /** All pair attempts captured so far. */
  readonly pairAttempts: PairRequestPayload[]
  /** All /api/v1/_rpc/<command> calls captured so far (also served at GET /__control/rpc-calls). */
  readonly rpcCalls: RpcCapture[]
  /** Reset state so a fresh test starts clean (keeps the HTTP server up). */
  reset(): void
}

export function createMockV2Server(): MockV2Server {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express")
  app.use(express.json({ limit: "1mb" }))

  // Permissive CORS: in browser-based E2E the app origin is
  // http://localhost:3000 while this mock binds 127.0.0.1:<port>, and
  // CompanionTransport sends Authorization/Idempotency-Key headers — the
  // preflight would otherwise kill every call with "Failed to fetch".
  // (Real clients — Capacitor native HTTP, Tauri reqwest — never preflight.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, res: any, next: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "*")
    if (req.method === "OPTIONS") {
      res.status(204).end()
      return
    }
    next()
  })

  let server: Server | null = null
  let _port = 0

  let pairScenario: PairScenario = {
    kind: "ok",
    body: {},
    fingerprint: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  }
  let whoamiFingerprint: string | null =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  let statusResponse: "ok" | "expired" | "offline" = "ok"
  const pairAttempts: PairRequestPayload[] = []
  const pairResolvers: Array<(payload: PairRequestPayload) => void> = []
  const rpcCalls: RpcCapture[] = []
  const knownRpcCommands = new Set<string>([
    ...MOBILE_OUTBOUND_COMMANDS,
    // Read-only health probe used by PairedStep. The native dispatcher
    // exposes it on the same /_rpc route as outbound mobile commands.
    "claude_sidecar_status",
  ])
  const sseClients = new Set<{
    write: (chunk: string) => void
    close: () => void
  }>()

  // ── POST /api/v1/auth/pair ─────────────────────────────────────────────
  app.post("/api/v1/auth/pair", (req: unknown, res: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = req as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = res as any
    const body = r.body as PairRequestPayload
    pairAttempts.push(body)
    const resolver = pairResolvers.shift()
    if (resolver) resolver(body)

    switch (pairScenario.kind) {
      case "ok": {
        const merged: PairResponseBody = {
          device_id:
            pairScenario.body?.device_id ?? `device_${Math.random().toString(36).slice(2, 8)}`,
          device_jwt: pairScenario.body?.device_jwt ?? "device.jwt.value",
          server_version: pairScenario.body?.server_version ?? "1.0.0",
        }
        s.status(200).json(merged)
        return
      }
      case "invalid-jwt":
        s.status(403).json({ error: "invalid_pair_jwt", message: "Pair JWT is not valid." })
        return
      case "expired":
        s.status(pairScenario.status ?? 401).json({
          error: "token_expired",
          message:
            pairScenario.message ?? "Pair JWT has expired. Generate a fresh one from the desktop.",
        })
        return
      case "fingerprint-mismatch":
        s.status(200).json({
          device_id: "device_fingerprint_test",
          device_jwt: "device.jwt.fpmismatch",
          server_version: "1.0.0",
        })
        // The /whoami call will subsequently report a different fingerprint
        // than `pinnedFingerprint`. The test sets that via setWhoamiFingerprint.
        return
      case "server-error":
        s.status(pairScenario.status).json({
          error: "server_error",
          message: pairScenario.message,
        })
        return
      case "unreachable":
        // Destroy the socket to simulate a network drop.
        try {
          s.socket?.destroy()
        } catch {
          // ignore destroy errors
        }
        return
    }
  })

  // ── GET /api/v1/whoami ─────────────────────────────────────────────────
  app.get("/api/v1/whoami", (_req: unknown, res: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = res as any
    s.json({
      tls_fingerprint: whoamiFingerprint ?? undefined,
      server_version: "1.0.0",
      device_id: "device_test",
    })
  })

  // ── GET /api/v1/status ─────────────────────────────────────────────────
  app.get("/api/v1/status", (_req: unknown, res: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = res as any
    if (statusResponse === "ok") {
      s.status(200).json({ ok: true, server_version: "1.0.0" })
    } else if (statusResponse === "expired") {
      s.status(401).json({ error: "token_expired", message: "Device JWT expired." })
    } else {
      s.status(503).json({ error: "offline", message: "Sidecar unreachable." })
    }
  })

  // ── GET /api/v1/events (SSE) ───────────────────────────────────────────
  app.get("/api/v1/events", (req: unknown, res: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = req as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = res as any
    s.setHeader("Content-Type", "text/event-stream")
    s.setHeader("Cache-Control", "no-cache, no-store")
    s.setHeader("Connection", "keep-alive")
    s.flushHeaders?.()
    const client = {
      write: (chunk: string) => s.write(chunk),
      close: () => {
        try {
          s.end()
        } catch {
          // already closed
        }
      },
    }
    sseClients.add(client)
    r.on("close", () => sseClients.delete(client))
    // Heartbeat keeps idle proxies happy.
    client.write(": connected\n\n")
  })

  // ── POST /api/v1/sidecar/call ──────────────────────────────────────────
  app.post("/api/v1/sidecar/call", (req: unknown, res: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = req as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = res as any
    const { method, params } = (r.body ?? {}) as { method: string; params?: unknown }
    if (method === "claude_sidecar_status") {
      s.json({ ok: true, result: { status: statusResponse } })
      return
    }
    s.json({ ok: true, result: { echo: { method, params } } })
  })

  // ── POST /api/v1/_rpc/:command ─────────────────────────────────────────
  // The endpoint `CompanionTransport.call()` drains outbound-queue rows to.
  // Mirrors the real dispatcher's contract (src-tauri/src/companion_api/rpc.rs):
  // commands outside MOBILE_OUTBOUND_COMMANDS get a 404 unknown_command, so a
  // spec that enqueues a rotten command goes red instead of green.
  app.post("/api/v1/_rpc/:command", (req: unknown, res: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = req as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = res as any
    const command = String(r.params.command)
    rpcCalls.push({
      command,
      body: r.body,
      idempotencyKey: r.header?.("Idempotency-Key") ?? null,
    })
    if (!knownRpcCommands.has(command)) {
      s.status(404).json({ error: "unknown_command", message: `Unknown command: ${command}` })
      return
    }
    s.status(200).json({ ok: true, result: {} })
  })

  // ── GET /__control/rpc-calls ───────────────────────────────────────────
  // Spec-side read of the capture array. The shared instance is booted in
  // the Playwright globalSetup process; worker-side specs can only reach it
  // over HTTP. Intentionally NO reset route: the instance is shared by
  // fullyParallel workers, so a per-test reset would wipe another worker's
  // captures mid-assertion — specs must filter by their own command/payload.
  app.get("/__control/rpc-calls", (_req: unknown, res: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(res as any).json(rpcCalls)
  })

  return {
    async start(port = 0): Promise<void> {
      await new Promise<void>((resolve) => {
        server = app.listen(port, () => {
          const addr = server!.address()
          _port = typeof addr === "object" && addr ? addr.port : port
          resolve()
        })
      })
    },
    async stop(): Promise<void> {
      // Force-close SSE first so server.close() doesn't hang on keep-alive.
      for (const c of sseClients) c.close()
      sseClients.clear()
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()))
      })
      server = null
    },
    get port() {
      return _port
    },
    get baseUrl() {
      return `http://127.0.0.1:${_port}`
    },
    setPairScenario(scenario) {
      pairScenario = scenario
    },
    setWhoamiFingerprint(fingerprint) {
      whoamiFingerprint = fingerprint
    },
    setStatusResponse(value) {
      statusResponse = value
    },
    pushEvent(event) {
      const chunk = `data: ${JSON.stringify(event)}\n\n`
      for (const c of sseClients) {
        try {
          c.write(chunk)
        } catch {
          // socket closed mid-write
        }
      }
    },
    closeAllStreams() {
      for (const c of sseClients) c.close()
      sseClients.clear()
    },
    waitForPair(timeoutMs = 5_000): Promise<PairRequestPayload> {
      if (pairAttempts.length > 0) {
        return Promise.resolve(pairAttempts[pairAttempts.length - 1])
      }
      return new Promise<PairRequestPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = pairResolvers.indexOf(resolve)
          if (i !== -1) pairResolvers.splice(i, 1)
          reject(new Error(`waitForPair timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        pairResolvers.push((payload) => {
          clearTimeout(timer)
          resolve(payload)
        })
      })
    },
    get pairAttempts() {
      return pairAttempts
    },
    get rpcCalls() {
      return rpcCalls
    },
    reset() {
      pairScenario = {
        kind: "ok",
        fingerprint: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      }
      whoamiFingerprint = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      statusResponse = "ok"
      pairAttempts.length = 0
      pairResolvers.length = 0
      rpcCalls.length = 0
    },
  }
}
