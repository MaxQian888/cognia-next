/**
 * The managed Pro IDE, end to end, against a real code-server.
 *
 * Every layer of the pathway has unit tests; this is the one place they run as
 * a whole. The pieces are the production ones:
 *
 * - code-server 4.128.0 and the bundled broker extension, started by the same
 *   headless path a companion host runs (`codeserver-e2e-host`, a thin stdio
 *   wrapper over `RemoteCodeServerState`);
 * - a workbench opened in headless Chromium, which is what makes code-server
 *   start an extension host at all;
 * - `ManagedIdeBrokerRuntime` and `ManagedProtocolRuntime` playing the
 *   renderer, with protocol servers supervised by the real vscode-ext-host
 *   sidecar;
 * - `plugins/pro-ide-fixture`, which contributes one provider of every family
 *   the platform claims for a stable release, built into a signed proxy VSIX
 *   and activated through the managed handshake.
 *
 * The extension's test probe (`COGNIA_CS_TEST_PROBE=1`, see
 * `sidecar/codeserver-agent-ext/src/test-probe.mjs`) asks VS Code what each
 * provider produced; a family that does not round-trip fails here. The same
 * run measures the performance gates and writes them for
 * `pnpm audit:pro-ide-perf`.
 *
 * Opt-in: needs a code-server binary, so it runs only with
 * `COGNIA_CODE_SERVER_BIN` set — `pnpm test:pro-ide:e2e` builds the pieces
 * and sets it. Without it the suite is skipped, and says so in its name.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

import type { CodeServerBrokerNotification, CodeServerBrokerRequest } from "@/lib/codeserver/client"
import { TauriLspClientAdapter } from "@/lib/plugin/lsp/lsp-client-adapter-tauri"
import fixtureHandlers from "@/plugins/pro-ide-fixture/src/index"
import type { Plugin, PluginManifest } from "@/types/plugin"

import { ManagedIdeBrokerRuntime, hashIdeManifest } from "./broker-runtime"
import { IDE_CAPABILITY_CATALOG } from "./catalog"
import { normalizeIdeManifest } from "./manifest"
import { ManagedProtocolRuntime } from "./protocol-runtime"
import { collectProxyAssets } from "./proxy-manager"

const REPO = join(__dirname, "..", "..", "..")
const CODE_SERVER_BIN = process.env.COGNIA_CODE_SERVER_BIN
const HOST_BIN =
  process.env.COGNIA_E2E_HOST_BIN ?? join(REPO, "target", "debug", "codeserver-e2e-host")
const BROKER_VSIX =
  process.env.COGNIA_CODE_SERVER_AGENT_VSIX ??
  join(REPO, "sidecar", "codeserver-agent-ext", "cognia-managed-broker.vsix")
const SIDECAR_HOST = join(REPO, "sidecar", "vscode-ext-host", "dist", "host.js")
const PERF_OUT = process.env.COGNIA_PRO_IDE_PERF_OUT ?? join(REPO, "target", "pro-ide-perf.json")
const FIXTURE_ROOT = join(REPO, "plugins", "pro-ide-fixture")
const NS = "cognia.cognia-pro-ide-fixture"
const PROXY_EXTENSION = "cognia-managed.proxy-cognia-pro-ide-fixture"
/** Optional: append every host frame and stderr line here, for diagnosing a failure. */
const DEBUG_LOG = process.env.COGNIA_E2E_LOG
const debug = (line: string) => {
  if (DEBUG_LOG) appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`)
}

// Dormant by design without a binary; the name says so in every report.
const describeReal = CODE_SERVER_BIN ? describe : describe.skip
const SUITE = CODE_SERVER_BIN
  ? "managed Pro IDE against a real code-server"
  : "managed Pro IDE against a real code-server (skipped: set COGNIA_CODE_SERVER_BIN)"

jest.setTimeout(300_000)

// ── Line-delimited JSON child processes ────────────────────────────────────

/** The E2E host: commands on stdin, ready/event/reply frames on stdout. */
class HostProcess {
  private nextId = 1
  private readonly pending = new Map<number, (frame: Record<string, unknown>) => void>()
  private readonly listeners = new Set<(event: string, payload: unknown) => void>()
  readonly ready: Promise<Record<string, unknown>>
  readonly child: ChildProcess

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(HOST_BIN, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let resolveReady!: (frame: Record<string, unknown>) => void
    let rejectReady!: (error: Error) => void
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    let stderr = ""
    this.child.stderr!.on("data", (chunk) => {
      stderr += chunk
      debug(`host stderr: ${chunk}`)
    })
    this.child.on("exit", (code) => {
      rejectReady(new Error(`host exited ${code}: ${stderr}`))
      // `shutdown` exits without answering; nothing may wait on a dead host.
      for (const settle of [...this.pending.values()]) {
        settle({ ok: false, error: `host exited ${code}` })
      }
    })
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      debug(`host: ${line.slice(0, 2000)}`)
      const frame = JSON.parse(line) as Record<string, unknown>
      if (frame.type === "ready") resolveReady(frame)
      else if (frame.type === "reply") this.pending.get(frame.id as number)?.(frame)
      else if (frame.type === "event") {
        for (const listener of this.listeners) listener(frame.event as string, frame.payload)
      }
    })
  }

  call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, (frame) => {
        this.pending.delete(id)
        if (frame.ok) resolve(frame.result as T)
        else reject(new Error(String(frame.error)))
      })
      this.child.stdin!.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  onEvent(listener: (event: string, payload: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** The vscode-ext-host sidecar, spoken to exactly as the Rust host does. */
class SidecarProcess {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private readonly handlers = new Map<string, Set<(params: unknown) => unknown>>()
  readonly child: ChildProcess

  constructor() {
    this.child = spawn(process.execPath, [SIDECAR_HOST], { stdio: ["pipe", "pipe", "pipe"] })
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let frame: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: unknown
      }
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (frame.method) {
        for (const handler of this.handlers.get(frame.method) ?? []) void handler(frame.params)
        if (frame.id !== undefined) {
          this.child.stdin!.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: null })}\n`
          )
        }
        return
      }
      const waiter = frame.id === undefined ? undefined : this.pending.get(frame.id)
      if (!waiter) return
      this.pending.delete(frame.id!)
      if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)))
      else waiter.resolve(frame.result)
    })
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  on(method: string, handler: (params: unknown) => unknown): () => void {
    const set = this.handlers.get(method) ?? new Set()
    set.add(handler)
    this.handlers.set(method, set)
    return () => set.delete(handler)
  }
}

// ── Measurement ─────────────────────────────────────────────────────────────

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!
}

/** Resident memory of every descendant of `pid`, in MiB. */
function treeRssMb(pid: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/).map(Number) as [number, number, number])
  const children = new Map<number, number[]>()
  for (const [child, parent] of rows) children.set(parent, [...(children.get(parent) ?? []), child])
  const rss = new Map(rows.map(([child, , kb]) => [child, kb]))
  let totalKb = 0
  const queue = [...(children.get(pid) ?? [])]
  while (queue.length) {
    const next = queue.pop()!
    totalKb += rss.get(next) ?? 0
    queue.push(...(children.get(next) ?? []))
  }
  return totalKb / 1024
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await fn()
  return performance.now() - started
}

const until = async (condition: () => boolean, label: string, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// ── The suite ───────────────────────────────────────────────────────────────

describeReal(SUITE, () => {
  const startedAt = performance.now()
  const workspace = mkdtempSync(join(tmpdir(), "cognia-pro-ide-e2e-ws-"))
  const dataDir = mkdtempSync(join(tmpdir(), "cognia-pro-ide-e2e-data-"))
  const manifest = JSON.parse(
    readFileSync(join(FIXTURE_ROOT, "plugin.json"), "utf8")
  ) as PluginManifest
  let host: HostProcess
  let sidecar: SidecarProcess
  let browser: { close(): Promise<void> }
  let ready: { root: string; port: number; hostId: string; relayPath: string; relayOrigin: string }
  let connected = false
  let coldReadinessMs = 0
  const brokerErrors: string[] = []

  const probe = <T = unknown>(params: Record<string, unknown>) =>
    host.call<T>("request", { root: ready.root, method: "testProbe", params })
  const file = (name: string) => join(ready.root, name)

  beforeAll(async () => {
    writeFileSync(join(workspace, "sample.txt"), "first line\nsecond line\n")
    writeFileSync(join(workspace, "a.cfx"), "fixture source\n")
    writeFileSync(join(workspace, "main.cfx"), "program\n")
    writeFileSync(join(workspace, "doc.cfxed"), "custom editor document\n")
    writeFileSync(
      join(workspace, "notes.cfxnb"),
      JSON.stringify({
        cells: [
          { kind: "markup", value: "# Fixture" },
          // Plain text, not JavaScript: a JavaScript cell wakes VS Code's
          // TypeScript server, whose memory would swamp the idle RSS gate.
          { kind: "code", value: "1 + 1", languageId: "plaintext" },
        ],
      })
    )

    host = new HostProcess(["--data-dir", dataDir, "--root", workspace], {
      ...process.env,
      COGNIA_CODE_SERVER_BIN: CODE_SERVER_BIN,
      COGNIA_CODE_SERVER_AGENT_VSIX: BROKER_VSIX,
      COGNIA_CS_TEST_PROBE: "1",
    })
    ready = (await host.ready) as typeof ready
    sidecar = new SidecarProcess()

    const plugin = {
      manifest,
      status: "enabled",
      path: FIXTURE_ROOT,
    } as unknown as Plugin
    const fixture = fixtureHandlers as unknown as Record<string, (...args: unknown[]) => unknown>
    const notify = (root: string, generation: number, params: unknown) =>
      host.call<void>("notify", { root, generation, params })
    const protocols = new ManagedProtocolRuntime({
      listProxies: () => host.call("listProxies"),
      ensureHost: async () => undefined,
      createLspAdapter: () =>
        new TauriLspClientAdapter({
          invoke: (_channel, method, payload) => sidecar.request(method, payload),
          registerHandler: (method, handler) => sidecar.on(method, handler),
          isHostAvailable: () => true,
        }),
      notify,
      invokeHost: (method, payload) => sidecar.request(method, payload),
      onHostMessage: (listener) => {
        const removeMessage = sidecar.on("protocol:message", (p) => listener("protocol:message", p))
        const removeState = sidecar.on("protocol:state", (p) => listener("protocol:state", p))
        return () => {
          removeMessage()
          removeState()
        }
      },
      readSetting: () => undefined,
    })
    const store = new Map<string, unknown>()
    const runtime = new ManagedIdeBrokerRuntime({
      expectedHostId: ready.hostId,
      notify,
      getPlugin: (pluginId) => (pluginId === manifest.id ? plugin : undefined),
      isWorkspaceTrusted: async () => true,
      validatePaths: (root, paths) => host.call("validatePaths", { root, paths }),
      createContent: (root, generation, pluginId, providerId, permission, bytes) =>
        host.call("createContent", {
          root,
          generation,
          pluginId,
          providerId,
          permission,
          mediaType: "application/octet-stream",
          bytes: Array.from(bytes),
        }),
      redeemContent: async (root, generation, pluginId, providerId, permission, handleId) =>
        Uint8Array.from(
          await host.call<number[]>("redeemContent", {
            root,
            generation,
            pluginId,
            providerId,
            permission,
            handleId,
          })
        ),
      authorize: async () => true,
      requirePermission: () => undefined,
      invoke: async (_pluginId, handler, args) => fixture[handler]!(...args),
      invokeAgent: async () => {
        throw new Error("the fixture declares no agents")
      },
      protocolStart: (input) => protocols.start(input),
      protocolRequest: (input) => protocols.request(input),
      protocolCancel: (input) => protocols.cancel(input),
      protocolDocument: (input) => protocols.document(input),
      protocolStop: (input) => protocols.stop(input),
      getUserId: () => "e2e-user",
      stateGet: async (_p, _s, key) => store.get(key),
      stateSet: async (_p, _s, key, value) => void store.set(key, value),
      stateDelete: async (_p, _s, key) => void store.delete(key),
      stateKeys: async () => [...store.keys()],
      secretGet: async () => null,
      secretSet: async () => undefined,
      secretDelete: async () => undefined,
      secretKeys: async () => [],
      now: () => Date.now(),
    })

    // The renderer's half of `attachManagedIdeBroker`, over the host's stdio.
    host.onEvent((event, payload) => {
      if (event === "codeserver://broker-request") {
        const request = payload as CodeServerBrokerRequest
        void runtime
          .dispatch(request)
          .then(
            (result) =>
              host.call("respond", {
                root: request.root,
                generation: request.generation,
                requestId: request.id,
                result,
              }),
            (error: { code?: number; message?: string; data?: unknown }) => {
              const message = error?.message ?? String(error)
              // A debug adapter exits on `disconnect`, and VS Code still asks it
              // for `threads` on the way out: refusing that (the session is gone,
              // or its process has just exited) is the protocol working, not a
              // family failing.
              const lateDebugRequest =
                (request.params as { family?: string } | undefined)?.family === "dap" &&
                /IDE_PROTOCOL_SESSION_NOT_RUNNING|IDE_PROTOCOL_PROCESS_EXITED: code=0/.test(message)
              if (!lateDebugRequest) brokerErrors.push(`${request.method}: ${message}`)
              return host.call("respond", {
                root: request.root,
                generation: request.generation,
                requestId: request.id,
                error: {
                  code: typeof error?.code === "number" ? error.code : -32000,
                  message: error?.message ?? String(error),
                  data: error?.data,
                },
              })
            }
          )
          .catch((error: Error) => {
            // A request the old extension host sent just before a restart is
            // answered after it is gone, and the channel refuses the answer:
            // that is the restart working. Anything else is a failure.
            if (/not connected|was replaced|was deregistered/.test(error.message)) {
              debug(`late answer to generation ${request.generation} dropped: ${error.message}`)
            } else {
              brokerErrors.push(`respond ${request.method}: ${error.message}`)
            }
          })
      } else if (event === "codeserver://broker-notification") {
        runtime.cancel(payload as CodeServerBrokerNotification)
      } else if (
        event === "codeserver://editor-event" &&
        (payload as { name?: string }).name === "bridgeConnected"
      ) {
        connected = true
      }
    })

    // code-server starts an extension host only for a connected workbench.
    const { chromium } = await import("@playwright/test")
    const launched = await chromium.launch({ headless: true })
    browser = launched
    const page = await launched.newPage()
    page.on("console", (message) => debug(`workbench ${message.type()}: ${message.text()}`))
    await page.goto(`http://127.0.0.1:${ready.port}/?folder=${encodeURIComponent(ready.root)}`)
    await until(() => connected, "the broker extension to connect", 120_000)
    coldReadinessMs = performance.now() - startedAt

    const normalized = normalizeIdeManifest(manifest.id, manifest).manifest
    const artifact = await host.call("buildProxy", {
      request: {
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        pluginRoot: FIXTURE_ROOT,
        manifestHash: await hashIdeManifest(normalized),
        catalogHash: IDE_CAPABILITY_CATALOG.catalogHash,
        contributions: normalized.contributions,
        providers: normalized.providers,
        executables: normalized.executables,
        protocols: normalized.protocols,
        assets: collectProxyAssets(FIXTURE_ROOT, normalized.contributions),
      },
    })
    expect(await host.call("installProxy", { artifact })).toBe(true)
  })

  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    if (host) {
      await host.call("shutdown").catch(() => undefined)
      host.child.kill()
    }
    sidecar?.child.kill()
    // `COGNIA_E2E_KEEP=1` leaves both behind: code-server's logs are under the data dir.
    if (process.env.COGNIA_E2E_KEEP !== "1") {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    } else debug(`kept workspace ${workspace} and data ${dataDir}`)
  })

  afterEach(() => {
    // A provider that failed in the runtime fails the family that called it.
    expect(brokerErrors.splice(0)).toEqual([])
  })

  it("serves a CodeLens from the plugin, and its click lands in the plugin's command", async () => {
    const lenses = await probe<Array<{ command: { command: string; title: string } }>>({
      action: "command",
      command: "vscode.executeCodeLensProvider",
      open: file("sample.txt"),
      args: [{ $uri: `file://${file("sample.txt")}` }],
    })
    const lens = lenses.find((entry) => entry.command?.command === `${NS}.ping`)
    expect(lens?.command.title).toBe("Cognia fixture: sample.txt")
    // The runtime refuses a path outside the workspace, so the click carries
    // one inside it, as a lens on a workspace file does.
    expect(
      await probe({
        action: "command",
        command: `${NS}.ping`,
        args: [{ path: file("sample.txt") }],
      })
    ).toEqual({ ok: true, path: file("sample.txt") })
  })

  it("LSP: hover comes from the supervised language server", async () => {
    const hovers = await probe<Array<{ contents: unknown[] }>>({
      action: "command",
      command: "vscode.executeHoverProvider",
      open: file("a.cfx"),
      args: [{ $uri: `file://${file("a.cfx")}` }, { $position: [0, 3] }],
    })
    expect(JSON.stringify(hovers)).toContain("Cognia fixture hover: a.cfx 0:3")
  })

  it("DAP: a launch runs through the supervised debug adapter", async () => {
    const output = await probe<string[]>({
      action: "debug",
      configuration: {
        type: `${NS}.fixture-dap`,
        request: "launch",
        name: "Fixture",
        program: "main.cfx",
      },
    })
    expect(output.join("")).toContain("Cognia fixture debug: main.cfx")
  })

  it("MCP: the stdio server's tools are listed through the platform relay", async () => {
    expect(await probe({ action: "mcp", providerId: `${NS}.fixture-mcp` })).toEqual([
      "fixture_echo",
    ])
  })

  it("SCM: the plugin's changes appear as a resource group", async () => {
    expect(await probe({ action: "scm", id: `${NS}.fixture-scm` })).toEqual({
      label: "Cognia Fixture VCS",
      count: 1,
      groups: [
        { id: "changes", label: "Changes", resources: ["file:///cognia-fixture/changed.txt"] },
      ],
    })
  })

  it("tests: a run reports pass, fail and an unreported test as skipped", async () => {
    const run = await probe<{ settled: string[]; skipped: string[] }>({
      action: "runTests",
      controllerId: `${NS}.fixture-tests`,
    })
    expect(run.settled.sort()).toEqual(["fixture.adds", "fixture.fails"])
    expect(run.skipped).toEqual(["fixture.unreported"])
  })

  it("notebooks: the serializer opens the file and the kernel writes outputs", async () => {
    const cells = await probe<Array<{ kind: string; success?: boolean; outputs: unknown[][] }>>({
      action: "notebook",
      path: file("notes.cfxnb"),
      controllerId: `${NS}.fixture-kernel`,
      extensionId: PROXY_EXTENSION,
    })
    expect(cells.map((cell) => cell.kind)).toEqual(["markup", "code"])
    expect(cells[1]).toMatchObject({
      success: true,
      outputs: [[{ mime: "text/plain", text: "fixture ran: 1 + 1" }]],
    })
  })

  it("webviews: the view and the custom editor render the plugin's pages", async () => {
    const view = await probe<{ htmlLength: number }>({
      action: "webviewView",
      viewId: `${NS}.fixture-view`,
    })
    expect(view.htmlLength).toBeGreaterThan(0)
    const editor = await probe<{ uri: string; htmlLength: number }>({
      action: "customEditor",
      path: file("doc.cfxed"),
      viewType: `${NS}.fixture-editor`,
    })
    expect(editor.uri).toMatch(/doc\.cfxed$/)
    expect(editor.htmlLength).toBeGreaterThan(0)
  })

  it("chat: participant registered, model answers, tool runs", async () => {
    expect(await probe({ action: "chatParticipants" })).toContain(`${NS}.fixture-chat`)
    expect(
      await probe({ action: "languageModel", vendor: `${NS}.fixture-lm`, prompt: "abc" })
    ).toMatchObject({ text: "fixture model: cba" })
    expect(
      await probe({
        action: "tool",
        name: "cognia_cognia-pro-ide-fixture_fixture-tool",
        input: { text: "hi" },
      })
    ).toEqual(["tool: hi"])
  })

  it("a restarted extension host reconnects and re-registers the proxy", async () => {
    const restarted = await host.call<{ previous: number; generation: number }>(
      "restartExtensionHost",
      { root: ready.root }
    )
    expect(restarted.generation).toBeGreaterThan(restarted.previous)
    // The proxy came back with the new host: it activates just after the
    // broker reconnects, registers source control, then fills it from the
    // plugin's first status answer.
    const deadline = Date.now() + 15_000
    let scm: unknown
    while (Date.now() < deadline) {
      scm = await probe({ action: "scm", id: `${NS}.fixture-scm` }).catch((error: Error) => error)
      if (scm instanceof Error && !scm.message.includes("TEST_PROBE_NOT_REGISTERED")) break
      if ((scm as { count?: number }).count === 1) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(scm).toMatchObject({ count: 1 })
  })

  it("measures the performance gates", async () => {
    const rpc: number[] = []
    for (let i = 0; i < 200; i += 1) {
      rpc.push(await timed(() => host.call("request", { root: ready.root, method: "ping" })))
    }
    const direct = `http://127.0.0.1:${ready.port}/healthz`
    const relayed = `${ready.relayOrigin}${ready.relayPath}healthz`
    const overhead: number[] = []
    for (let i = 0; i < 100; i += 1) {
      const viaRelay = await timed(() => fetch(relayed).then((response) => response.text()))
      const viaLoopback = await timed(() => fetch(direct).then((response) => response.text()))
      overhead.push(Math.max(0, viaRelay - viaLoopback))
    }
    // Zero lifecycle-event loss within declared capacity: a burst under the
    // companion event bus's broadcast capacity (256) arrives whole and in order.
    const burst = 200
    const seen: number[] = []
    const stopListening = host.onEvent((event, payload) => {
      const editorEvent = payload as { name?: string; payload?: { seq?: number } }
      if (event === "codeserver://editor-event" && editorEvent.name === "testProbeEvent") {
        seen.push(editorEvent.payload?.seq ?? -1)
      }
    })
    const { sent } = await probe<{ sent: number }>({ action: "emitEvents", count: burst })
    const eventDeadline = Date.now() + 5_000
    while (seen.length < burst && Date.now() < eventDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    stopListening()
    expect(sent).toBe(burst)
    expect(seen).toEqual([...Array(burst).keys()])

    // Settle before reading idle memory: the activation burst is not idle.
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    const result = {
      platform: `${process.platform}-${process.arch}`,
      codeServer: "4.128.0",
      coldReadinessMs: Math.round(coldReadinessMs),
      idleRssMb: Math.round(treeRssMb(host.child.pid!)),
      emptyRpcP95Ms: Number(p95(rpc).toFixed(2)),
      relayOverheadP95Ms: Number(p95(overhead).toFixed(2)),
      eventLoss: burst - seen.length,
    }
    mkdirSync(dirname(PERF_OUT), { recursive: true })
    writeFileSync(PERF_OUT, `${JSON.stringify(result, null, 2)}\n`)
    expect(result.emptyRpcP95Ms).toBeGreaterThan(0)
  })
})

if (!CODE_SERVER_BIN) {
  // Keep the file a valid suite when skipped, so the skip shows in reports.
  it.skip("needs COGNIA_CODE_SERVER_BIN", () => undefined)
}
