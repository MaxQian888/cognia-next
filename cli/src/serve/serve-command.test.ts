/**
 * `cognia-agent serve` end-to-end against an in-process scripted server
 * (ADR-0059 T-B3): boot → hello/hello_ack → runtimes up → a sync-pull frame
 * answered from the brain's Dexie → graceful shutdown with a final flush.
 *
 * @jest-environment node
 */
import fs from "node:fs"
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

    const code = await serveCommand(parseArgv(["serve", "--home", home]), {
      out,
      env: env({
        COGNIA_SERVER_URL: "https://127.0.0.1:7999",
        COGNIA_SERVICE_TOKEN: "svc-token-e2e",
      }),
      wsFactory: (url) => new FakeServerSocket(url),
      shutdown,
      onStarted,
    })

    expect(code).toBe(0)
    const joined = out.logs.join("")
    expect(joined).toContain("bridge connected")
    expect(joined).toContain("desktop-sync-source")

    // The shutdown flush persisted the seeded row.
    const snapshotPath = path.join(home, "db-local_acct_a.json")
    void snapshotPath
    const files = fs.readdirSync(home)
    expect(files).toContain("db-local_acct_a.json")
    const snapshot = fs.readFileSync(path.join(home, "db-local_acct_a.json"), "utf8")
    expect(snapshot).toContain("s-e2e")

    __resetCliDbForTesting()
  }, 30_000)
})
