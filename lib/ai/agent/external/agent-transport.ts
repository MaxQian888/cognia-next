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
 */
// `isTauri` via @/lib/utils (the app-wide re-export the existing agent test
// suites mock); `isHeadlessHost` from the platform leaf.
import { isHeadlessHost } from "@/lib/platform/detect"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { isTauri } from "@/lib/utils"
import type { AcpHostCapabilities } from "./acp-feature-profile"
import { canStartExternalAgentProcess } from "./process-plane"

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
  return isTauri() || isHeadlessHost() || canStartExternalAgentProcess()
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
  return isTauri() || isHeadlessHost()
}

/** Whether the ACP fs capability (read/write text file) is available. */
export function supportsAgentFs(): boolean {
  return isTauri() || isHeadlessHost()
}

/** Whether the ACP terminal capability is available (desktop-only). */
export function supportsAgentTerminal(): boolean {
  return isTauri()
}

/** Runtime-owned ACP capability truth shared through the CLI build alias. */
export function getAcpHostCapabilities(): AcpHostCapabilities {
  const desktop = isTauri()
  const headless = isHeadlessHost()
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
      providers: desktop || headless,
      dynamicMcp: desktop || headless,
      nes: desktop,
      identifiedPlans: true,
      previewToolNames: true,
      sessionFork: true,
    },
  }
}

/** Invoke a process-plane command on whichever host is present. */
export async function agentInvoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<T>(name, args)
  }
  const { transport } = await import("@/lib/tauri/transport-instance")
  return transport.call<T>(name, args)
}

/**
 * Subscribe to a process-plane event channel. The handler receives the RAW
 * payload (both hosts deliver the identical frozen shapes).
 */
export async function agentListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event")
    return listen<T>(event, (e) => handler(e.payload))
  }
  const { transport } = await import("@/lib/tauri/transport-instance")
  const off = transport.subscribe<T>(event, handler)
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
  if (typeof ready === "function") await ready.call(transport, [event])
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
  if (!supportsAgentFs()) {
    throw new Error("File system access not available in browser")
  }
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  await agentInvoke("fs_write_workspace_file", { root, relPath, content })
}
