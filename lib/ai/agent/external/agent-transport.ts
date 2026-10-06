/**
 * Host indirection for the external-agent process plane (ADR-0059 T-A10).
 *
 * `acp-client.ts` historically bound to Tauri statically (`invoke`, `listen`,
 * `@tauri-apps/plugin-fs`). This module collapses those into host-resolved
 * calls so the SAME orchestration drives external agents on:
 *
 * - **Tauri desktop** — `invoke`/`listen`, exactly as before (lazy imports;
 *   jest mocks of `@tauri-apps/*` keep working).
 * - **The headless brain** — the process `Transport`
 *   (`CompanionTransport` → the R11 service-scope RPC arms + the frozen
 *   `external-agent://*` events over `/ws/events`).
 *
 * Terminal support stays desktop-only (no headless `acp_terminal_*` arms) —
 * the ACP capability advertisement reflects that.
 *
 * A shell with its own process table (the standalone CLI) installs an
 * {@link InstalledExternalAgentHost} at startup; every export here then
 * delegates to its process plane (ADR-0217).
 */
// `isTauri` via @/lib/utils (the app-wide re-export the existing agent test
// suites mock); `isHeadlessHost` from the platform leaf.
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { isHeadlessHost } from "@/lib/platform/detect"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { isTauri } from "@/lib/utils"
import type { AcpHostCapabilities } from "@cognia/agent-acp/feature-profile"
import { canStartExternalAgentProcess } from "./capability/process-plane"
import { withSpawnPlacement } from "@/lib/sandbox/spawn-placement-registry"
import {
  getActiveRemoteTransport,
  getActiveRemoteEndpoint,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import { getInstalledExternalAgentHost } from "./host/installed-host"

/** The installed shell's process plane, or `undefined` in the app. */
function installedPlane() {
  return getInstalledExternalAgentHost()?.process
}

// A process id belongs to the Host that spawned it. Switching the selected
// Host must never redirect a send/kill to an identically named remote process.
const processHosts = new Map<string, string | Transport | null>()
const processSubscriptions = new WeakMap<Transport, Set<Promise<void>>>()

function processHostIdentity(remote: Transport | null): string | Transport | null {
  if (!remote) return null
  const endpoint = getActiveRemoteEndpoint()
  if (!endpoint) return remote
  // A replacement connection to the same authenticated Host may resume the
  // process. A different device/key or Host certificate cannot reuse its id.
  return JSON.stringify([
    endpoint.serverFingerprint || endpoint.baseUrl,
    endpoint.deviceId,
    endpoint.deviceKeyThumbprint,
  ])
}

export function __resetAgentProcessHostsForTests(): void {
  processHosts.clear()
}

function localProcessTarget(): boolean {
  return !getActiveRemoteTransport() && (isTauri() || isHeadlessHost())
}

/**
 * Whether an external agent process can be started from here at all.
 *
 * The first two terms are the shells with a process table of their own. The
 * third is the case this used to miss: a browser or phone paired to a Host,
 * which spawns nothing itself but reaches `spawn_external_agent` over the
 * companion RPC plane, exactly as `agentInvoke` below already routed it. The
 * plane also checks the Host declares the feature and granted this device
 * `process.spawn`, so a `true` here means the call will be authorized rather
 * than answered with 403.
 *
 * The first two terms are kept ahead of it deliberately: a shell with its own
 * process table stays supported even before any runtime snapshot exists, which
 * is the state during boot and in every test that never wires one.
 */
export function supportsExternalAgents(): boolean {
  const installed = installedPlane()
  if (installed) return installed.supportsExternalAgents()
  return localProcessTarget() || canStartExternalAgentProcess()
}

/**
 * Whether THIS shell has a process table of its own.
 *
 * Narrower than {@link supportsExternalAgents}, and the two are not
 * interchangeable. That one answers "can an agent process be started for me",
 * which a paired browser can do by asking its Host. This one answers "can it be
 * started *here*", which is what a caller needs when the work does not cross
 * the companion plane: a local-only Tauri command, or a transport that spawns
 * the child itself.
 *
 * Reaching for the wider predicate in those places is how a browser ends up
 * being offered a control whose command can only ever be answered locally.
 */
export function runsExternalAgentProcessesLocally(): boolean {
  const installed = installedPlane()
  if (installed) return installed.runsExternalAgentProcessesLocally()
  return localProcessTarget()
}

/** Whether the ACP fs capability (read/write text file) is available. */
export function supportsAgentFs(): boolean {
  const installed = installedPlane()
  if (installed) return installed.supportsAgentFs()
  return localProcessTarget() || canStartExternalAgentProcess()
}

/** Whether the ACP terminal capability is available (desktop-only). */
export function supportsAgentTerminal(): boolean {
  const installed = installedPlane()
  if (installed) return installed.supportsAgentTerminal()
  return isTauri() && !getActiveRemoteTransport()
}

/** Runtime-owned ACP capability truth; an installed shell answers for itself. */
export function getAcpHostCapabilities(): AcpHostCapabilities {
  const installed = installedPlane()
  if (installed) return installed.getAcpHostCapabilities()
  const desktop = isTauri() && !getActiveRemoteTransport()
  const headless = isHeadlessHost() || Boolean(getActiveRemoteTransport())
  return {
    kind: desktop ? "desktop" : "headless",
    fs: { read: desktop || headless, write: desktop || headless },
    terminal: desktop,
    terminalAuth: desktop,
    elicitation: {
      form: desktop,
      url: desktop,
      durableInteraction: desktop,
    },
    preview: {
      compaction: true,
      notices: desktop,
      providers: desktop || headless,
      dynamicMcp: desktop || headless,
      nes: desktop,
      identifiedPlans: true,
      previewToolNames: true,
      sessionFork: true,
    },
  }
}

/**
 * Invoke a process-plane command on whichever host is present.
 *
 * A spawn picks up the run's runtime-environment placement on the way past
 * (ADR-0182). This is the one seam every client's spawn goes through, so no
 * runtime can lose its placement by being the one that was not updated — and
 * with no placement registered `withSpawnPlacement` returns the caller's own
 * object, so a deployment without runtime environments sends exactly the
 * payload it always did. An installed shell receives the caller's arguments
 * unchanged and owns placement for the processes it starts.
 */
export async function agentInvoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const installed = installedPlane()
  if (installed) return installed.invoke<T>(name, args)
  if (name === "spawn_external_agent") args = withSpawnPlacement(args)
  const remote = getActiveRemoteTransport()
  const hostIdentity = processHostIdentity(remote)
  const agentId = typeof args.agentId === "string" ? args.agentId : undefined
  if (agentId && processHosts.has(agentId) && processHosts.get(agentId) !== hostIdentity) {
    throw new Error("External agent belongs to a different Host; reconnect to its original Host")
  }
  const config = args.config as { id?: string; env?: Record<string, string> } | undefined
  if (
    name === "spawn_external_agent" &&
    config?.id &&
    processHosts.has(config.id) &&
    processHosts.get(config.id) !== hostIdentity
  ) {
    throw new Error("External agent id is already bound to a different Host")
  }
  if (remote && name === "spawn_external_agent" && config?.env) {
    if (config.env.COGNIA_GATEWAY_TASK_CONFIG || config.env.COGNIA_GATEWAY_TOKEN) {
      const { assertRemoteGatewayTask } = await import("@/lib/gateway/remote-task-lease")
      assertRemoteGatewayTask(config.env, remote)
    }
    if (config.env.COGNIA_TOOLHOST_SOCKET || config.env.COGNIA_TOOLHOST_TOKEN) {
      throw new Error("Remote Cognia tool host transport is not configured")
    }
  }
  // Bind before dispatch: a timeout may mean the Host already spawned the
  // child, so a retry must never reuse its id on another Host.
  if (name === "spawn_external_agent" && config?.id) processHosts.set(config.id, hostIdentity)
  let result: T
  if (remote) {
    await Promise.all(processSubscriptions.get(remote) ?? [])
    if (getActiveRemoteTransport() !== remote) throw new Error("External agent Host changed")
    result = await remote.call<T>(name, args)
  } else if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    if (getActiveRemoteTransport() !== remote) throw new Error("External agent Host changed")
    result = await invoke<T>(name, args)
  } else {
    const { transport } = await import("@/lib/tauri/transport-instance")
    if (getActiveRemoteTransport() !== remote) throw new Error("External agent Host changed")
    result = await transport.call<T>(name, args)
  }
  if (name === "spawn_external_agent") {
    if (config?.id) processHosts.set(config.id, hostIdentity)
    if (typeof result === "string") processHosts.set(result, hostIdentity)
  }
  return result
}

/**
 * Subscribe to a process-plane event channel. The handler receives the RAW
 * payload (both hosts deliver the identical frozen shapes).
 */
export async function agentListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  const installed = installedPlane()
  if (installed) return installed.listen<T>(event, handler)
  const remote = getActiveRemoteTransport()
  if (remote) {
    const hostIdentity = processHostIdentity(remote)
    let disposed = false
    let off: (() => void) | undefined
    let revision = 0
    function bind(target: Transport | null): Promise<void> {
      revision += 1
      const currentRevision = revision
      off?.()
      off = undefined
      if (!target || processHostIdentity(target) !== hostIdentity) return Promise.resolve()
      off = target.subscribe<T>(event, (payload) => {
        if (!disposed && currentRevision === revision && getActiveRemoteTransport() === target)
          handler(payload)
      })
      const ready = (
        target as Transport & { whenSubscribed?: (channels: readonly string[]) => Promise<void> }
      ).whenSubscribed
      const pending = Promise.resolve().then(async () => {
        if (ready) await ready.call(target, [event])
        if (disposed || currentRevision !== revision || getActiveRemoteTransport() !== target)
          throw new Error("External agent Host changed during subscription")
      })
      const waits = processSubscriptions.get(target) ?? new Set<Promise<void>>()
      processSubscriptions.set(target, waits)
      waits.add(pending)
      void pending.then(
        () => waits.delete(pending),
        () => {
          if (currentRevision === revision) {
            off?.()
            off = undefined
          }
          // Retain failed readiness so a send cannot hang on a listenerless process.
        }
      )
      return pending
    }
    const stopWatching = subscribeActiveRemoteTransport((target) => {
      void bind(target).catch(() => undefined)
    })
    try {
      await bind(remote)
    } catch (error) {
      stopWatching()
      off?.()
      throw error
    }
    return () => {
      disposed = true
      revision += 1
      stopWatching()
      off?.()
    }
  }
  if (isTauri() && !remote) {
    const { listen } = await import("@tauri-apps/api/event")
    if (getActiveRemoteTransport() !== remote) throw new Error("External agent Host changed")
    const off = await listen<T>(event, (e) => {
      if (getActiveRemoteTransport() === remote) handler(e.payload)
    })
    return () => safeUnlisten(off)
  }
  const transport = remote ?? (await import("@/lib/tauri/transport-instance")).transport
  if (getActiveRemoteTransport() !== remote) throw new Error("External agent Host changed")
  const off = transport.subscribe<T>(
    event,
    remote
      ? (payload) => {
          if (getActiveRemoteTransport() === remote) handler(payload)
        }
      : handler
  )
  // Tauri's `listen` resolves once the listener is registered, so every caller
  // here was written to treat the await as "the host will deliver this now".
  // The companion plane's `subscribe` is synchronous and its control frame is
  // dropped while the socket is still opening, so the same await proved
  // nothing. Every `external-agent://*` channel is `default_on: false`, which
  // means nothing at all is delivered until the host has been asked, and the
  // first caller after a cold start (the Pi version probe: subscribe, spawn
  // `pi --version`, read stdout) reliably outran its own subscription and read
  // an empty stream. It then reported the agent as an unsupported version.
  const ready = (transport as { whenSubscribed?: (channels: readonly string[]) => Promise<void> })
    .whenSubscribed
  try {
    if (typeof ready === "function") await ready.call(transport, [event])
    if (getActiveRemoteTransport() !== remote) throw new Error("External agent Host changed")
  } catch (error) {
    off()
    throw error
  }
  return off
}

function resolveSessionWorkspacePath(
  path: string,
  allowedRoots: string[]
): { root: string; relPath: string } {
  const root = allowedRoots.find((candidate) => {
    return /^[A-Za-z]:[\\/]|^\\\\/.test(candidate)
      ? isPathUnderRoot(path, candidate, "win32")
      : isPathUnderRoot(path, candidate)
  })
  if (!root) {
    throw new Error(`Path is outside the ACP session workspace roots: ${path}`)
  }
  const normalizedRoot = root.replace(/[\\/]+$/, "")
  const relPath = path.slice(normalizedRoot.length).replace(/^[\\/]+/, "")
  return { root, relPath }
}

/** Read a text file through the host's symlink-aware workspace boundary. */
export async function agentReadTextFile(path: string, allowedRoots: string[]): Promise<string> {
  const installed = installedPlane()
  if (installed) return installed.readTextFile(path, allowedRoots)
  if (!supportsAgentFs()) {
    throw new Error("File system access not available in browser")
  }
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  return agentInvoke<string>("fs_read_workspace_file", { root, relPath, maxBytes: undefined })
}

/** Write a text file through the host's symlink-aware workspace boundary. */
export async function agentWriteTextFile(
  path: string,
  content: string,
  allowedRoots: string[]
): Promise<void> {
  const installed = installedPlane()
  if (installed) return installed.writeTextFile(path, content, allowedRoots)
  if (!supportsAgentFs()) {
    throw new Error("File system access not available in browser")
  }
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  await agentInvoke("fs_write_workspace_file", { root, relPath, content })
}

/** Delete a runtime-owned file through the existing workspace boundary. */
export async function agentDeleteTextFile(path: string, allowedRoots: string[]): Promise<void> {
  const installed = installedPlane()
  if (installed) return installed.deleteTextFile(path, allowedRoots)
  if (!supportsAgentFs()) throw new Error("File system access not available in browser")
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  await agentInvoke("fs_delete_workspace_entry", { root, relPath, recursive: false })
}

/** Runtime attachments use the same confined host filesystem as text files. */
export async function agentWriteBinaryFile(
  path: string,
  base64: string,
  allowedRoots: string[]
): Promise<void> {
  const installed = installedPlane()
  if (installed) return installed.writeBinaryFile(path, base64, allowedRoots)
  if (!supportsAgentFs()) throw new Error("File system access not available in browser")
  const decodedLength =
    (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0)
  if (
    base64.length % 4 !== 0 ||
    decodedLength > 20 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new Error("Invalid or oversized base64 attachment")
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  await agentInvoke("fs_write_workspace_file", {
    root,
    relPath,
    content: base64,
    encoding: "base64",
  })
}

export async function agentReadBinaryFile(path: string, allowedRoots: string[]): Promise<string> {
  const installed = installedPlane()
  if (installed) return installed.readBinaryFile(path, allowedRoots)
  if (!supportsAgentFs()) throw new Error("File system access not available in browser")
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  return agentInvoke<string>("fs_read_workspace_file_base64", {
    root,
    relPath,
    maxBytes: 20 * 1024 * 1024,
  })
}

/** List only immediate files; adapters validate their own manifest names and contents. */
export async function agentListFiles(path: string, allowedRoots: string[]): Promise<string[]> {
  const installed = installedPlane()
  if (installed) return installed.listFiles(path, allowedRoots)
  if (!supportsAgentFs()) throw new Error("File system access not available in browser")
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  const entries = await agentInvoke<Array<{ absolute_path: string; is_dir: boolean }>>(
    "fs_list_workspace_dir",
    { root, relPath, includeIgnored: true }
  )
  return entries.filter((entry) => !entry.is_dir).map((entry) => entry.absolute_path)
}
