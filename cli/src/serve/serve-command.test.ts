/**
 * `cognia-agent serve` end-to-end against an in-process scripted server
 * (ADR-0059 T-B3): boot → hello/hello_ack → runtimes up → a sync-pull frame
 * answered from the brain's Dexie → graceful shutdown with a final flush.
 *
 * @jest-environment node
 */
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"

import type { OutputSink } from "../cli/output"
import { parseArgv } from "../cli/args"
import { __resetCliDbForTesting } from "../db/bootstrap"
import type { WebSocketLike } from "./bridge-client"
import { serveCommand } from "./serve-command"

type Listener = (event: { data?: unknown }) => void

/** A scripted cognia-server: acks hellos, records responds. */
class FakeServerSocket implements WebSocketLike {
  static last: FakeServerSocket | null = null
  sent: string[] = []
  private listeners = new Map<string, Listener[]>()

  constructor(public url: string) {
    FakeServerSocket.last = this
    // The bridge attaches its listeners synchronously after construction.
    setTimeout(() => this.fire("open", {}), 0)
  }

  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as { type: string; accountId?: string }
    if (frame.type === "hello") {
      setTimeout(
        () =>
          this.serverSend({
            v: 1,
            type: "hello_ack",
            serverVersion: "0.0.0-test",
            protocol: 1,
            accountId: frame.accountId,
          }),
        0
      )
    }
  }

  close(): void {
    this.fire("close", {})
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  fire(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  serverSend(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) })
  }

  responds(): Array<{ command: string; payload: Record<string, unknown> }> {
    return this.sent
      .map((s) => JSON.parse(s) as { type: string; command: string; payload: never })
      .filter((f) => f.type === "respond")
  }
}

/**
 * The control-plane half of the scripted server: a real HTTP listener that
 * answers every `CompanionTransport.call` with a non-retryable 404.
 *
 * Booting the brain activates the whole built-in plugin roster, and each
 * activation awaits host RPCs (`mirrorDeclaredPermissionsToLedger`,
 * `syncShellAllowlistToHost`, …). Pointed at a dead port those are *network*
 * errors, which the transport retries three times with 250/500/1000 ms backoff
 * — ~1.75 s burned per plugin permission, minutes across the roster. A 4xx is
 * terminal on the first attempt, so the boot keeps the same end state (the
 * mirrors are best-effort and still fail) without the backoff.
 */
async function startControlPlane(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ code: "unknown_command", message: "not served by the test brain" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function sink(): OutputSink & { logs: string[] } {
  const logs: string[] = []
  return {
    logs,
    write: (s: string) => {
      logs.push(s)
    },
    error: (s: string) => {
      logs.push(`[err] ${s}`)
    },
    json: (value: unknown) => {
      logs.push(JSON.stringify(value))
    },
  }
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...extra } as NodeJS.ProcessEnv
}

describe("serveCommand", () => {
  it("fails fast without a server url or a service token", async () => {
    const out = sink()
    expect(await serveCommand(parseArgv(["serve"]), { out, env: env() })).toBe(2)
    expect(
      await serveCommand(parseArgv(["serve"]), {
        out,
        env: env({ COGNIA_SERVER_URL: "https://127.0.0.1:7999" }),
      })
    ).toBe(2)
    expect(out.logs.join("")).toContain("COGNIA_SERVICE_TOKEN")
  })

  it("boots, answers a sync-pull from Dexie, and flushes on shutdown", async () => {
    __resetCliDbForTesting()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-e2e-"))
    const controlPlane = await startControlPlane()
    const out = sink()
    let releaseShutdown: () => void = () => undefined
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })

    const onStarted = async (): Promise<void> => {
      // Seed one session row in the brain's Dexie.
      const { getDb } = await import("@/lib/db/schema")
      const now = Date.now()
      await getDb()
        .table("sessions")
        .put({ id: "s-e2e", title: "from the brain", createdAt: now, updatedAt: now })

      // The server asks for it over the bridge.
      const server = FakeServerSocket.last!
      server.serverSend({
        v: 1,
        type: "event",
        event: "companion://sync-pull-request",
        payload: {
          request_id: "rid-e2e-1",
          table: "sessions",
          since: 0,
          account_id: "local_acct_a",
        },
      })

      // Await the respond frame.
      for (let i = 0; i < 100; i++) {
        const respond = server.responds().find((f) => f.payload.requestId === "rid-e2e-1")
        if (respond) {
          expect(respond.command).toBe("companion_sync_pull_response")
          expect(respond.payload.error).toBeNull()
          const delta = respond.payload.delta as { rows: Array<{ id: string }> }
          expect(delta.rows.some((row) => row.id === "s-e2e")).toBe(true)
          releaseShutdown()
          return
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`no respond frame arrived; sent=${JSON.stringify(server.sent)}`)
    }

    let code: number
    try {
      code = await serveCommand(parseArgv(["serve", "--home", home]), {
        out,
        env: env({
          COGNIA_SERVER_URL: controlPlane.url,
          COGNIA_SERVICE_TOKEN: "svc-token-e2e",
        }),
        wsFactory: (url) => new FakeServerSocket(url),
        shutdown,
        onStarted,
      })
    } finally {
      await controlPlane.close()
    }

    expect(code).toBe(0)
    const joined = out.logs.join("")
    expect(joined).toContain("bridge connected")
    expect(joined).toContain("desktop-sync-source")

    // The shutdown flush persisted the seeded row.
    const snapshotDirectory = path.join(home, "db-local_acct_a.json.tables")
    const files = fs.readdirSync(home)
    expect(files).toContain("db-local_acct_a.json.tables")
    const manifest = JSON.parse(
      fs.readFileSync(path.join(snapshotDirectory, "manifest.json"), "utf8")
    ) as { snapshotFormat: number; dbs: Record<string, { tables: string[] }> }
    expect(manifest.snapshotFormat).toBe(3)
    const primaryDatabaseName = Object.keys(manifest.dbs).find(
      (name) => name !== "CogniaSchedulerDB"
    )
    expect(primaryDatabaseName).toBeDefined()
    expect(manifest.dbs[primaryDatabaseName!].tables).toContain("sessions")
    const sessionsFile = fs
      .readdirSync(snapshotDirectory)
      .find((name) => name.endsWith("--sessions.json"))
    expect(sessionsFile).toBeDefined()
    const sessions = JSON.parse(
      fs.readFileSync(path.join(snapshotDirectory, sessionsFile!), "utf8")
    ) as Array<{ id: string }>
    expect(sessions.some((session) => session.id === "s-e2e")).toBe(true)

    const { __resetDbForTesting } = await import("@/lib/db/schema")
    __resetDbForTesting()
    __resetCliDbForTesting()
    fs.rmSync(home, { recursive: true, force: true })
  }, 30_000)
})
