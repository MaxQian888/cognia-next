/**
 * The lifecycle plane's runtime host on a machine that has processes.
 *
 * Two hosts qualify — Tauri desktop and the headless brain — and both answer
 * the same command names through {@link agentInvoke}, so this module is written
 * once for both. A browser or Capacitor shell has neither, and gets no runtime
 * host at all; the service then refuses every runtime operation with
 * `platform_unsupported` rather than pretending.
 *
 * ## What is real here, and what is not
 *
 * **Real:** version certification. The host runs the catalogued probe, and
 * `assessRuntimeVersion` turns the output into a verdict. That is the whole
 * point of this module: until it existed, `probeVersion` was a port with no
 * implementation, so every runtime assessed as "missing" and the certification
 * policy never ran on anything.
 *
 * **Not implemented:** moving bytes. Installing, updating, rolling back and
 * uninstalling need a staged-install host (download, verify, extract, swap)
 * that does not exist on any host yet, so {@link unavailableProviderHost}
 * refuses those operations with `platform_unsupported` and a reason. That is
 * not a stub standing in for working code — no runtime in
 * `protocol/external-agent-runtimes.json` currently catalogues a distribution
 * to install, so a full provider host would have nothing to act on either. The
 * refusal is the honest state of the feature, and it is typed rather than
 * silent.
 *
 * @see ./runtime-host.ts for the operations themselves
 * @see crates/cognia-external-agent/src/version_probe.rs for the desktop probe
 */

import {
  ExternalAgentLifecycleError,
  type ExternalAgentRuntimeCatalogEntry,
  type ExternalAgentRuntimeReceipt,
} from "@/types/agent/external-agent-lifecycle"

import { agentInvoke, supportsExternalAgents } from "../agent-transport"
import type { RuntimeProbeObservation } from "../runtime-version"
import type { ProviderHost } from "./providers"
import type { ReceiptStore } from "./receipts"
import { createRuntimeHost, type RuntimeHostDependencies } from "./runtime-host"
import type { LifecycleRuntimeHost } from "./service"

/** Command name; also registered in the headless backend under this name. */
export const PROBE_COMMAND = "external_agent_probe_runtime_version"

/** Preference key holding this host's receipts, keyed by runtime id. */
export const RECEIPT_STORE_KEY = "externalAgent.runtimeReceipts"

/** What the host reports back. Mirrors `RuntimeVersionProbe` in Rust. */
export interface NativeVersionProbe {
  output?: string | null
  executablePath?: string | null
  executableDigest?: string | null
  exitCode?: number | null
  detail?: string | null
}

/** Ports this module needs, injected so the wiring is testable off-host. */
export interface NativeRuntimeHostDependencies {
  invoke: <T>(name: string, args: Record<string, unknown>) => Promise<T>
  getPref: <T>(key: string) => Promise<T | null>
  setPref: <T>(key: string, value: T) => Promise<void>
  /** `<os>-<arch>`, resolved once at construction because the port is sync. */
  platformKey: string
  now?: () => Date
}

// ============================================================================
// Receipts
// ============================================================================

/**
 * Receipts on the host's own preference store.
 *
 * Host-local on purpose: a receipt describes bytes on *this* machine, and
 * syncing one to another device would claim an installation that is not there.
 *
 * `save` reads back what it wrote. The underlying store swallows write failures
 * and no-ops entirely outside Tauri, and a receipt that silently fails to
 * persist is the worst possible outcome — the next `inspect` would find no
 * receipt, treat a managed tree as unowned, and lose the rollback slot.
 */
export function createNativeReceiptStore(
  deps: Pick<NativeRuntimeHostDependencies, "getPref" | "setPref">
): ReceiptStore {
  const readAll = async (): Promise<Record<string, ExternalAgentRuntimeReceipt>> => {
    const stored =
      await deps.getPref<Record<string, ExternalAgentRuntimeReceipt>>(RECEIPT_STORE_KEY)
    return stored && typeof stored === "object" ? stored : {}
  }

  return {
    async load(runtimeId) {
      return (await readAll())[runtimeId] ?? null
    },

    async save(receipt) {
      const all = await readAll()
      await deps.setPref(RECEIPT_STORE_KEY, { ...all, [receipt.runtimeId]: receipt })

      const persisted = (await readAll())[receipt.runtimeId]
      if (persisted?.receiptId !== receipt.receiptId) {
        throw new ExternalAgentLifecycleError(
          "integrity_failed",
          `the install receipt for ${receipt.runtimeId} did not persist; the installation is not recorded`,
          { runtimeId: receipt.runtimeId }
        )
      }
    },

    async delete(runtimeId) {
      const all = await readAll()
      if (!(runtimeId in all)) return
      delete all[runtimeId]
      await deps.setPref(RECEIPT_STORE_KEY, all)

      if (runtimeId in (await readAll())) {
        throw new ExternalAgentLifecycleError(
          "integrity_failed",
          `the install receipt for ${runtimeId} could not be removed`,
          { runtimeId }
        )
      }
    },
  }
}

// ============================================================================
// Version probe
// ============================================================================

/**
 * Run one runtime's catalogued version probe on this host.
 *
 * Only the runtime id crosses the boundary. The command, its arguments and its
 * timeout are read from the compiled-in catalog on the host side, so this can
 * never widen into an arbitrary-exec call — the same rule the DeepSeek Harness
 * commands follow.
 *
 * A host that cannot answer is reported as an unreadable version rather than
 * an absent runtime: those are different facts, and `assessRuntimeVersion`
 * treats them differently.
 */
export function createNativeProbe(
  deps: Pick<NativeRuntimeHostDependencies, "invoke">
): RuntimeHostDependencies["probeVersion"] {
  return async (entry: ExternalAgentRuntimeCatalogEntry) => {
    try {
      const probe = await deps.invoke<NativeVersionProbe>(PROBE_COMMAND, {
        runtimeId: entry.runtimeId,
      })
      return {
        output: probe.output ?? undefined,
        executablePath: probe.executablePath ?? undefined,
        executableDigest: probe.executableDigest ?? undefined,
      } satisfies Omit<RuntimeProbeObservation, "parser" | "checkedAt">
    } catch {
      // The host is there but the probe call failed (an older host with no
      // such command, a transport drop). Claiming the runtime is missing would
      // be a stronger statement than the evidence supports.
      return { output: "" }
    }
  }
}

// ============================================================================
// Provider host
// ============================================================================

/**
 * A provider host that owns no filesystem.
 *
 * Every operation that would move bytes refuses with `platform_unsupported`
 * and says so. `now` and `platformKey` are real, because `inspect` needs them
 * and answering those with a lie would corrupt the assessment timestamps.
 */
export function unavailableProviderHost(
  platformKey: string,
  now: () => Date = () => new Date()
): ProviderHost {
  const refuse = (operation: string): never => {
    throw new ExternalAgentLifecycleError(
      "platform_unsupported",
      `${operation} needs a managed-install host, which is not implemented yet; ` +
        "install this runtime with your own package manager",
      { operation }
    )
  }

  return {
    join: (...parts) => parts.filter(Boolean).join("/"),
    exists: async () => refuse("checking a managed install"),
    mkdirp: async () => refuse("creating a managed install directory"),
    removeDir: async () => refuse("removing a managed install directory"),
    rename: async () => refuse("activating a managed install"),
    writeFile: async () => refuse("writing to a managed install"),
    readFile: async () => refuse("reading a managed install"),
    hashFile: async () => refuse("hashing a managed install"),
    hashTree: async () => refuse("hashing a managed install tree"),
    exec: async () => refuse("running an install command"),
    download: async () => refuse("downloading a runtime"),
    extract: async () => refuse("unpacking a runtime"),
    platformKey: () => platformKey,
    now,
  }
}

// ============================================================================
// Assembly
// ============================================================================

/** Build the runtime host from explicit ports. */
export function createNativeRuntimeHost(deps: NativeRuntimeHostDependencies): LifecycleRuntimeHost {
  const now = deps.now ?? (() => new Date())
  return createRuntimeHost({
    host: unavailableProviderHost(deps.platformKey, now),
    receipts: createNativeReceiptStore(deps),
    // Never actually reached: every operation that would use it refuses first.
    // Named rather than empty so a future managed root is an obvious edit.
    rootDir: "cognia/external-agent-runtimes",
    resolveLockAsset: async () => undefined,
    probeVersion: createNativeProbe(deps),
  })
}

/**
 * The runtime host for whichever host this is, or `undefined` when there is
 * none.
 *
 * `undefined` is meaningful: the service refuses every runtime operation with
 * `platform_unsupported` rather than reporting an empty or "missing" state that
 * a browser shell has no standing to assert.
 */
export async function createHostRuntimeHost(): Promise<LifecycleRuntimeHost | undefined> {
  if (!supportsExternalAgents()) return undefined

  const [{ getPref, setPref }, platformKey] = await Promise.all([
    import("@/lib/tauri/store"),
    resolvePlatformKey(),
  ])

  return createNativeRuntimeHost({
    invoke: agentInvoke,
    getPref,
    setPref,
    platformKey,
  })
}

/**
 * `<os>-<arch>` for this machine, matching a binary artifact's key.
 *
 * Falls back to the Node-style platform when the OS plugin is unavailable
 * (the headless host runs in Node and has no Tauri plugins).
 */
async function resolvePlatformKey(): Promise<string> {
  try {
    const { getOsInfo } = await import("@/lib/tauri/os")
    const info = await getOsInfo()
    if (info) return `${info.platform}-${info.arch}`
  } catch {
    // Fall through to the process-level answer.
  }
  if (typeof process !== "undefined" && process.platform) {
    return `${process.platform}-${process.arch}`
  }
  return "unknown-unknown"
}
