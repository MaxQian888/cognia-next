/**
 * `cognia-agent serve` — the headless brain (ADR-0059 W3 / T-B3).
 *
 * Boot order (graceful stop reverses it):
 *
 *   1. env/flags → `__COGNIA_HEADLESS__` marker → fake-indexeddb shim
 *   2. `ensureHeadlessAccount` (registry create-if-missing + activate +
 *      guarded host unlock — `desktop-sync-source` rejects pulls otherwise)
 *   3. durability v1 (snapshot db + write-triggered flush + exit hooks)
 *   4. `setTransport(CompanionTransport)` with an in-memory config provider
 *      (service token, never persisted) — the control plane: `claude_send`
 *      flows brain → RPC → cognia-server → its sidecar
 *   5. `BridgeClient.connect()` + hello — the data plane the three
 *      installers answer on
 *   6. `bootstrapHeadlessRuntimes()` over the registered roster
 *   7. block on SIGINT/SIGTERM
 *
 * The sidecar is spawned by cognia-server (R8), NOT by the brain — no
 * transport conflict, and the WebView↔Tauri isomorphism holds exactly.
 */
import os from "node:os"
import path from "node:path"

// `serveCommand` is also imported directly by embedders and tests, bypassing
// the executable entry point. Install IndexedDB synchronously before any
// `@/lib` dependency can construct an eager Dexie singleton (notably the
// scheduler database); the async installer below adds the window/storage shims.
import "../db/install-indexeddb"

import { bootstrapHeadlessRuntimes } from "@/lib/headless/bootstrap"
import {
  installRemoteWorkerRuntime,
  type RemoteWorkerDescriptor,
} from "@/lib/ai/agent/team/remote-worker-runtime"
import { loadMessageResolver } from "@/lib/headless/i18n"
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"
import { setTransport } from "@/lib/tauri"
import { CompanionTransport, type CompanionConfig } from "@/lib/tauri/transport-companion"

import type { ParsedArgs } from "../cli/args"
import { numberFlag, stringFlag } from "../cli/args"
import type { OutputSink } from "../cli/output"
import { VERSION } from "../version"
import { ensureHeadlessAccount, HEADLESS_LOCAL_ACCOUNT_ID } from "./account"
import { createNodeBackupFilesystem } from "./backup-filesystem"
import { BridgeClient, type WebSocketLike } from "./bridge-client"
import { startDurability } from "./durability"
import { createNodePluginRuntimeAdapter } from "./plugin-runtime-adapter"
import { BridgeWorkerRpcPool } from "./worker-rpc-pool"

export interface ServeDeps {
  out: OutputSink
  env?: NodeJS.ProcessEnv
  /** Injected WS factory for the bridge (tests). */
  wsFactory?: (url: string) => WebSocketLike
  /** Resolves to trigger graceful shutdown (tests; defaults to SIGINT/SIGTERM). */
  shutdown?: Promise<void>
  /** Test hook: runs after the runtimes started, before blocking. */
  onStarted?: () => Promise<void> | void
  proc?: Pick<NodeJS.Process, "on" | "off" | "memoryUsage">
}

function deriveBridgeUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, "ws").replace(/\/$/, "")}/internal/bridge`
}

export function projectWorkerPlacement(worker: RemoteWorkerDescriptor) {
  const placementReason = !worker.manifest.executionProfile
    ? "execution_profile_missing"
    : !worker.manifest.taskWorkspace.enabled
      ? "task_workspace_unavailable"
      : worker.manifest.workspaceBindingRefs.length === 0
        ? "workspace_missing"
        : undefined
  return {
    hostRef: worker.hostRef,
    usedSlots: worker.activeTurns,
    placementReady: placementReason === undefined,
    ...(placementReason ? { placementReason } : {}),
  }
}

export async function serveCommand(args: ParsedArgs, deps: ServeDeps): Promise<number> {
  const { out } = deps
  const env = deps.env ?? process.env
  const proc = deps.proc ?? process

  // ── Config (canonical env contract; token is env-only, never argv) ────────
  const serverUrl = stringFlag(args, "server-url") ?? env.COGNIA_SERVER_URL
  if (!serverUrl) {
    out.error("serve: missing --server-url / COGNIA_SERVER_URL\n")
    return 2
  }
  const serviceToken = env.COGNIA_SERVICE_TOKEN
  if (!serviceToken) {
    out.error("serve: COGNIA_SERVICE_TOKEN is not set (env-only by design)\n")
    return 2
  }
  const accountId =
    stringFlag(args, "account") ?? env.COGNIA_LOCAL_ACCOUNT_ID ?? HEADLESS_LOCAL_ACCOUNT_ID
  const bridgeUrl = env.COGNIA_BRIDGE_URL ?? deriveBridgeUrl(serverUrl)
  const home =
    stringFlag(args, "home") ??
    (env.COGNIA_DATA_DIR
      ? path.join(env.COGNIA_DATA_DIR, "serve")
      : path.join(os.homedir(), ".cognia", "serve"))
  const flushDebounce = numberFlag(args, "flush-debounce")

  // ── 1. Headless marker + IndexedDB shim ────────────────────────────────────
  ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
  await installFakeIndexedDb()

  // ── 2. Account ─────────────────────────────────────────────────────────────
  await ensureHeadlessAccount(accountId)
  out.write(`serve: account ${accountId} unlocked\n`)

  // ── 3. Durability ──────────────────────────────────────────────────────────
  const durability = await startDurability({
    home,
    accountId,
    debounceMs: flushDebounce,
    proc,
  })

  // ── 4. Control plane: CompanionTransport with the service token ───────────
  let currentToken = serviceToken
  const configProvider = (): CompanionConfig => ({
    baseUrl: serverUrl,
    serviceToken: currentToken,
    deviceId: `brain-${accountId}`,
    serverVersion: "headless",
  })
  const transport = new CompanionTransport({
    configProvider,
    rpcPath: "/internal/_rpc",
    eventsPath: "/internal/events",
  })
  setTransport(transport)

  // ── 5. Data plane: the bridge WS ───────────────────────────────────────────
  const bridgeRef: { current: BridgeClient | null } = { current: null }
  const workerPool = new BridgeWorkerRpcPool({
    sendFrame: (connectionId, frame) => {
      if (!bridgeRef.current) throw new Error("brain bridge is not connected")
      bridgeRef.current.sendWorkerFrame(connectionId, frame)
    },
    onWorkersChanged: (workers) => {
      void transport
        .call("fleet_project_worker_load", {
          loads: workers.map(projectWorkerPlacement),
        })
        .catch(() => undefined)
    },
  })
  const bridge = new BridgeClient({
    url: bridgeUrl,
    token: currentToken,
    accountId,
    brainVersion: VERSION,
    wsFactory: deps.wsFactory,
    onTokenRefresh: (token) => {
      currentToken = token
    },
    onWorkerAttach: ({ connectionId, hostRef, manifest }) =>
      workerPool.attach({
        connectionId,
        hostRef,
        manifest,
      }),
    onWorkerFrame: (connectionId, frame) => workerPool.receive(connectionId, frame),
    onWorkerDetach: ({ connectionId, reason }) => workerPool.detach(connectionId, reason),
    rss: () => durability.rss(),
    log: (level, message) => {
      if (level === "error") out.error(`serve: ${message}\n`)
      else out.write(`serve: ${message}\n`)
    },
  })
  bridgeRef.current = bridge
  await bridge.connect()
  const uninstallWorkerRuntime = installRemoteWorkerRuntime(workerPool)
  out.write(`serve: bridge connected (${bridgeUrl})\n`)

  // ── 6. Runtimes ────────────────────────────────────────────────────────────
  await import("@/lib/headless/runtimes")
  const resolveMessage = await loadMessageResolver("en")
  const runtimes = await bootstrapHeadlessRuntimes({
    host: "brain",
    accountId,
    bridge,
    notifyDbWrite: durability.notifyDbWrite,
    backupFilesystem: createNodeBackupFilesystem(),
    pluginRuntime: createNodePluginRuntimeAdapter(),
    resolveMessage,
    log: (level, message) => {
      if (level === "error") out.error(`serve: ${message}\n`)
      else out.write(`serve: ${message}\n`)
    },
  })
  out.write(
    `serve: runtimes up (${runtimes.started.join(", ") || "none"})` +
      (runtimes.failed.length
        ? ` — FAILED: ${runtimes.failed.map((f) => f.name).join(", ")}`
        : "") +
      "\n"
  )

  await deps.onStarted?.()

  // ── 7. Block until shutdown ────────────────────────────────────────────────
  await (deps.shutdown ??
    new Promise<void>((resolve) => {
      const onSignal = (): void => resolve()
      proc.on("SIGINT", onSignal)
      proc.on("SIGTERM", onSignal)
    }))

  out.write("serve: shutting down…\n")
  await runtimes.stop()
  uninstallWorkerRuntime()
  workerPool.close()
  bridge.close()
  transport.destroy()
  await durability.dispose()
  out.write("serve: stopped\n")
  return 0
}
