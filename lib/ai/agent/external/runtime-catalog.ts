/**
 * Typed access to `protocol/external-agent-runtimes.json`.
 *
 * The install-side twin of {@link ./security-policy}: that module answers "may
 * Cognia launch this command", this one answers "may Cognia install, certify
 * and update this runtime, and from where". Both read a single checked-in JSON
 * for the same reason — the preset list, the launch allowlist and the install
 * commands each used to exist in more than one place and had already drifted.
 *
 * Behavior here is pure and host-agnostic: selecting a provider, resolving a
 * launch, and reporting what is missing. Actually installing bytes belongs to
 * the provider adapters, which run on a host that has a filesystem.
 *
 * @see types/agent/external-agent-lifecycle.ts
 */

import CATALOG from "@/protocol/external-agent-runtimes.json"
import {
  isJsRuntimeProvider,
  type ExternalAgentDistribution,
  type ExternalAgentLifecycleErrorCode,
  type ExternalAgentRuntimeCatalog,
  type ExternalAgentRuntimeCatalogEntry,
  type ExternalAgentRuntimeProvider,
} from "@/types/agent/external-agent-lifecycle"

const catalog = CATALOG as unknown as ExternalAgentRuntimeCatalog

export const EXTERNAL_AGENT_RUNTIME_CATALOG_VERSION = catalog.version

/** Every runtime the catalog governs. */
export const EXTERNAL_AGENT_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = catalog.runtimes

/** Runtimes still launching through a resolving package runner, with reasons. */
export const UNPINNED_LAUNCH_WAIVERS: Readonly<Record<string, string>> =
  catalog.unpinnedLaunchWaivers.runtimes

export function findRuntimeById(runtimeId: string): ExternalAgentRuntimeCatalogEntry | undefined {
  return EXTERNAL_AGENT_RUNTIMES.find((entry) => entry.runtimeId === runtimeId)
}

export function findRuntimeByPresetId(
  presetId: string
): ExternalAgentRuntimeCatalogEntry | undefined {
  return EXTERNAL_AGENT_RUNTIMES.find((entry) => entry.presetIds.includes(presetId))
}

/** Every preset id the catalog claims to cover. */
export function catalogedPresetIds(): string[] {
  return EXTERNAL_AGENT_RUNTIMES.flatMap((entry) => entry.presetIds)
}

// ============================================================================
// Platform support
// ============================================================================

/** Tauri spells platforms differently from Node; accept both, as the policy does. */
const PLATFORM_ALIASES: Record<string, string> = {
  macos: "darwin",
  windows: "win32",
  win: "win32",
}

export function normalizePlatform(platform: string): string {
  return PLATFORM_ALIASES[platform] ?? platform
}

export function runtimeSupportsPlatform(
  entry: ExternalAgentRuntimeCatalogEntry,
  platform: string
): boolean {
  return entry.platforms.includes(normalizePlatform(platform))
}

// ============================================================================
// Provider selection
// ============================================================================

export interface ProviderSelectionInput {
  /** Global preferred JavaScript provider, from settings. */
  preferred?: ExternalAgentRuntimeProvider
  /** Per-runtime override, which wins over the global preference. */
  override?: ExternalAgentRuntimeProvider
  /** Providers whose tool is actually present on this host. */
  available?: readonly ExternalAgentRuntimeProvider[]
}

export interface ProviderSelection {
  distribution?: ExternalAgentDistribution
  /**
   * Whether the chosen provider differs from what the caller asked for. A
   * provider switch is never silent — the caller must surface this.
   */
  switchedFromRequested: boolean
  /** The provider the caller asked for, when one was requested. */
  requested?: ExternalAgentRuntimeProvider
  /** Why no distribution could be selected. */
  blockingCode?: ExternalAgentLifecycleErrorCode
  /** Non-localized detail for logs; UI text is keyed on `blockingCode`. */
  detail?: string
}

/**
 * Can this distribution be installed without resolving anything at install time?
 *
 * JavaScript and uvx distributions need an approved frozen lock; binary
 * distributions need an https source and a checksum on every artifact.
 */
export function isDistributionInstallable(distribution: ExternalAgentDistribution): boolean {
  if (distribution.provider === "binary") {
    return (
      distribution.artifacts.length > 0 &&
      distribution.artifacts.every(
        (artifact) =>
          artifact.url.startsWith("https://") && /^[0-9a-f]{64}$/.test(artifact.integrity.sha256)
      )
    )
  }
  const lock = distribution.lockAsset
  return Boolean(lock?.path) && /^[0-9a-f]{64}$/.test(lock?.sha256 ?? "")
}

/**
 * Pick the managed distribution to install.
 *
 * Only distributions that are actually installable are considered: a JS or uvx
 * distribution without an approved frozen lock is not offered at all, because
 * offering it would mean resolving a range at install time — the exact problem
 * the lock exists to prevent.
 */
export function selectDistribution(
  entry: ExternalAgentRuntimeCatalogEntry,
  input: ProviderSelectionInput = {}
): ProviderSelection {
  const requested = input.override ?? input.preferred
  const installable = entry.distributions.filter(isDistributionInstallable)

  if (installable.length === 0) {
    return {
      switchedFromRequested: false,
      requested,
      blockingCode: "runtime_missing",
      detail:
        entry.distributions.length === 0
          ? `no managed distribution is catalogued for ${entry.runtimeId}`
          : `every catalogued distribution for ${entry.runtimeId} lacks an approved lock or integrity record`,
    }
  }

  const available = input.available
  const usable = available
    ? installable.filter((distribution) => available.includes(distribution.provider))
    : installable

  if (usable.length === 0) {
    return {
      switchedFromRequested: false,
      requested,
      blockingCode: "runtime_missing",
      detail: `no provider tool for ${entry.runtimeId} is available on this host`,
    }
  }

  const exact = requested
    ? usable.find((distribution) => distribution.provider === requested)
    : undefined
  if (exact) {
    return { distribution: exact, switchedFromRequested: false, requested }
  }

  // Catalog order is the preference order, so falling back is deterministic.
  return {
    distribution: usable[0],
    switchedFromRequested: requested !== undefined,
    requested,
  }
}

// ============================================================================
// Launch resolution
// ============================================================================

export interface ResolvedLaunch {
  command: string
  args: string[]
}

/**
 * The command a `system` runtime launches, straight from the catalog.
 *
 * Managed runtimes launch their receipt's entrypoint instead, which only the
 * host that installed them can resolve; remote runtimes launch nothing.
 */
export function resolveSystemLaunch(
  entry: ExternalAgentRuntimeCatalogEntry
): ResolvedLaunch | undefined {
  if (!entry.systemCommand) return undefined
  return { command: entry.systemCommand, args: [...(entry.launchArgs ?? [])] }
}

/**
 * Does this runtime still launch through a network-resolving package runner?
 *
 * `npx -y <pkg>` re-resolves the package on every start, so the bytes that run
 * can change under the user without any consent. That is a governance hole, and
 * it has to be nameable to be counted.
 */
export function isUnpinnedLaunch(entry: ExternalAgentRuntimeCatalogEntry): boolean {
  const command = entry.systemCommand
  if (!command) return false
  const base = command.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "")
  return base === "npx" || base === "uvx" || base === "pnpx" || base === "bunx"
}

/** Is this runtime's unpinned launch recorded as a known, reasoned hole? */
export function hasUnpinnedLaunchWaiver(runtimeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(UNPINNED_LAUNCH_WAIVERS, runtimeId)
}

/**
 * Canonical text of what would actually launch, for the consent digest.
 *
 * JSON-encoded rather than space-joined so two different argument lists can
 * never canonicalize to the same string: `["a b"]` and `["a", "b"]` launch
 * different things and must not share a consent record.
 */
export function canonicalLaunchCommandString(launch: ResolvedLaunch): string {
  return JSON.stringify([launch.command, ...launch.args])
}

// ============================================================================
// Sandbox and consent eligibility
// ============================================================================

/**
 * May this runtime be offered a Windows unsandboxed-launch consent?
 *
 * Three conditions, all required: the host is Windows, the catalog marks the
 * runtime eligible, and the runtime supports Windows at all. macOS and Linux
 * never reach this — their sandbox is mandatory and this returns false there,
 * so a caller cannot accidentally route a Unix launch through the consent path.
 */
export function isWindowsExceptionEligible(
  entry: ExternalAgentRuntimeCatalogEntry,
  platform: string
): boolean {
  return (
    normalizePlatform(platform) === "win32" &&
    entry.sandbox.windowsExceptionEligible &&
    runtimeSupportsPlatform(entry, platform)
  )
}

/** Providers whose distributions this runtime actually offers. */
export function offeredProviders(
  entry: ExternalAgentRuntimeCatalogEntry
): ExternalAgentRuntimeProvider[] {
  const seen: ExternalAgentRuntimeProvider[] = []
  for (const distribution of entry.distributions) {
    if (!isDistributionInstallable(distribution)) continue
    if (!seen.includes(distribution.provider)) seen.push(distribution.provider)
  }
  return seen
}

/** Does this runtime offer a choice between JavaScript providers? */
export function hasJsProviderChoice(entry: ExternalAgentRuntimeCatalogEntry): boolean {
  return offeredProviders(entry).filter(isJsRuntimeProvider).length > 1
}
