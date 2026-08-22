/**
 * The managed-runtime half of the lifecycle plane.
 *
 * Turns the provider adapters and the receipt store into the six operations the
 * lifecycle service exposes: inspect, install, check for update, update, roll
 * back, uninstall.
 *
 * The install sequence is the load-bearing part, and its order is the whole
 * safety property:
 *
 *   prepare into staging → verify against the catalog → health-check the STAGED
 *   tree → only then swap it into place → write the receipt
 *
 * Nothing touches the live installation until a candidate has proven it
 * downloads, matches its digests and actually runs. A failed install therefore
 * leaves the previous version serving, and a tree that installs but cannot
 * launch never becomes `current` at all.
 *
 * @see ./providers.ts for the per-provider contract
 * @see ./receipts.ts for what a completed install records
 */

import {
  ExternalAgentLifecycleError,
  type ExternalAgentRuntimeCatalogEntry,
  type ExternalAgentRuntimeProvider,
  type ExternalAgentRuntimeReceipt,
  type ExternalAgentUpdateCandidate,
  type ExternalAgentVersionAssessment,
} from "@/types/agent/external-agent-lifecycle"

import {
  findRuntimeById,
  isDistributionInstallable,
  runtimeSupportsPlatform,
  selectDistribution,
} from "../runtime-catalog"
import { assessRuntimeVersion, type RuntimeProbeObservation } from "../runtime-version"
import {
  availableProviders,
  getProviderAdapter,
  managedLayout,
  type ProviderContext,
  type ProviderHost,
} from "./providers"
import {
  buildReceipt,
  receiptFromRollback,
  receiptMatchesTree,
  type ReceiptStore,
} from "./receipts"
import type { LifecycleRuntimeHost } from "./service"

export interface InstallOptions {
  /** Exact version to install. Defaults to the catalog's preferred one. */
  version?: string
  /** Force one provider for this install. */
  provider?: ExternalAgentRuntimeProvider
  /**
   * Acknowledge that the chosen provider differs from the requested one.
   *
   * Without it a fallback refuses instead of switching: a provider change alters
   * which bytes get installed, and doing that quietly is the failure mode the
   * whole catalog exists to prevent.
   */
  acceptProviderSwitch?: boolean
}

export interface RuntimeHostDependencies {
  host: ProviderHost
  receipts: ReceiptStore
  /** Directory Cognia owns and may remove from. */
  rootDir: string
  /** Resolve a catalog lock path to an absolute path on this host. */
  resolveLockAsset(repoRelativePath: string): Promise<string | undefined>
  /** Global preferred JavaScript provider, from settings. */
  preferredProvider?: ExternalAgentRuntimeProvider
  /** Per-runtime provider overrides, from settings. */
  providerOverrides?: Readonly<Record<string, ExternalAgentRuntimeProvider>>
  /**
   * Run a catalog version probe against whatever is installed.
   *
   * Managed runtimes probe their receipt's entrypoint; `system` runtimes probe
   * the resolved executable. Absent output means "not found", which is a
   * verdict rather than an error.
   */
  probeVersion(
    entry: ExternalAgentRuntimeCatalogEntry,
    receipt: ExternalAgentRuntimeReceipt | null
  ): Promise<Omit<RuntimeProbeObservation, "parser" | "checkedAt">>
  /** Fetch a signed update-channel document. Absent = no update checking. */
  fetchUpdateChannel?(url: string): Promise<unknown>
  /**
   * Runtimes discovered at runtime rather than shipped in the catalog.
   *
   * ACP Registry entries live here. They go through the identical staged
   * install — a discovered runtime gets no shortcut around verification,
   * health-checking or receipts just because it was not in the JSON.
   */
  dynamicRuntimes?(): Iterable<ExternalAgentRuntimeCatalogEntry>
}

function findEntry(
  runtimeId: string,
  dynamic?: () => Iterable<ExternalAgentRuntimeCatalogEntry>
): ExternalAgentRuntimeCatalogEntry | undefined {
  // The shipped catalog wins: a discovered entry must never be able to shadow
  // a runtime whose policy the repo actually governs.
  const shipped = findRuntimeById(runtimeId)
  if (shipped) return shipped
  for (const entry of dynamic?.() ?? []) {
    if (entry.runtimeId === runtimeId) return entry
  }
  return undefined
}

function requireManaged(entry: ExternalAgentRuntimeCatalogEntry): void {
  if (entry.ownership !== "managed") {
    throw new ExternalAgentLifecycleError(
      "runtime_referenced",
      `${entry.runtimeId} is ${entry.ownership}-owned; Cognia does not install or remove it`,
      { runtimeId: entry.runtimeId, ownership: entry.ownership }
    )
  }
}

export function createRuntimeHost(deps: RuntimeHostDependencies): LifecycleRuntimeHost {
  const { host, receipts } = deps

  const requireEntry = (runtimeId: string): ExternalAgentRuntimeCatalogEntry => {
    const entry = findEntry(runtimeId, deps.dynamicRuntimes)
    if (!entry) {
      throw new ExternalAgentLifecycleError("runtime_missing", `unknown runtime: ${runtimeId}`, {
        runtimeId,
      })
    }
    return entry
  }

  async function buildContext(
    entry: ExternalAgentRuntimeCatalogEntry,
    options: InstallOptions
  ): Promise<{ context: ProviderContext; provider: ExternalAgentRuntimeProvider }> {
    if (!runtimeSupportsPlatform(entry, host.platformKey().split("-")[0])) {
      throw new ExternalAgentLifecycleError(
        "platform_unsupported",
        `${entry.runtimeId} does not support ${host.platformKey()}`,
        { runtimeId: entry.runtimeId, platformKey: host.platformKey() }
      )
    }

    const selection = selectDistribution(entry, {
      preferred: deps.preferredProvider,
      override: options.provider ?? deps.providerOverrides?.[entry.runtimeId],
      available: await availableProviders(host),
    })

    if (!selection.distribution) {
      throw new ExternalAgentLifecycleError(
        selection.blockingCode ?? "runtime_missing",
        selection.detail ?? `no installable distribution for ${entry.runtimeId}`,
        { runtimeId: entry.runtimeId }
      )
    }

    if (selection.switchedFromRequested && !options.acceptProviderSwitch) {
      throw new ExternalAgentLifecycleError(
        "consent_required",
        `${entry.runtimeId}: ${selection.requested} is unavailable; installing with ` +
          `${selection.distribution.provider} instead needs explicit confirmation`,
        {
          runtimeId: entry.runtimeId,
          requested: selection.requested ?? "",
          offered: selection.distribution.provider,
        }
      )
    }

    let distribution = selection.distribution
    if (options.version && distribution.version !== options.version) {
      const exact = entry.distributions.find(
        (candidate) =>
          candidate.version === options.version &&
          candidate.provider === distribution.provider &&
          isDistributionInstallable(candidate)
      )
      if (!exact) {
        throw new ExternalAgentLifecycleError(
          "integrity_failed",
          `${entry.runtimeId}: no approved ${distribution.provider} distribution for ${options.version}`,
          { runtimeId: entry.runtimeId, version: options.version }
        )
      }
      distribution = exact
    }

    const lockPath =
      distribution.provider === "binary"
        ? undefined
        : await deps.resolveLockAsset(distribution.lockAsset.path)

    return {
      provider: distribution.provider,
      context: {
        host,
        layout: managedLayout(host, deps.rootDir, entry.runtimeId),
        runtimeId: entry.runtimeId,
        distribution,
        lockAssetPath: lockPath,
      },
    }
  }

  /** prepare → verify → health → activate → receipt. */
  async function stagedInstall(
    entry: ExternalAgentRuntimeCatalogEntry,
    options: InstallOptions
  ): Promise<ExternalAgentRuntimeReceipt> {
    requireManaged(entry)
    const { context, provider } = await buildContext(entry, options)
    const adapter = getProviderAdapter(provider)

    const prepared = await adapter.prepare(context)

    const verification = await adapter.verify(context, prepared)
    if (!verification.ok) {
      await host.removeDir(context.layout.staging)
      throw new ExternalAgentLifecycleError(
        "integrity_failed",
        `${entry.runtimeId}: ${verification.detail ?? "staged tree failed verification"}`,
        { runtimeId: entry.runtimeId, provider }
      )
    }

    // Health runs against the STAGED entrypoint. A tree that installs but
    // cannot launch must never become `current`.
    const health = await adapter.healthCheck(context, prepared.entrypoint)
    if (!health.healthy) {
      await host.removeDir(context.layout.staging)
      throw new ExternalAgentLifecycleError(
        "integrity_failed",
        `${entry.runtimeId}: ${health.findings[0]?.detail ?? "health check failed"}`,
        { runtimeId: entry.runtimeId, provider }
      )
    }

    const previous = await receipts.load(entry.runtimeId)
    const { entrypoint } = await adapter.activate(context, prepared)
    const activatedAt = host.now().toISOString()

    const receipt = buildReceipt({
      runtimeId: entry.runtimeId,
      version: context.distribution.version,
      provider,
      providerVersion: await adapter.providerVersion(host),
      source: prepared.source,
      installRoot: context.layout.current,
      entrypoint,
      treeDigest: verification.treeDigest,
      lockDigest: prepared.lockDigest,
      integrity:
        context.distribution.provider === "binary"
          ? context.distribution.artifacts.find(
              (artifact) => artifact.platformKey === host.platformKey()
            )?.integrity
          : undefined,
      health,
      installedAt: activatedAt,
      activatedAt,
      replacing: previous,
    })

    await receipts.save(receipt)
    return receipt
  }

  return {
    async inspect(runtimeId) {
      const entry = requireEntry(runtimeId)
      const receipt = await receipts.load(runtimeId)
      const checkedAt = host.now().toISOString()

      if (!entry.versionProbe) {
        // A remote runtime has nothing local to probe; saying "missing" would
        // be a lie about something that was never meant to be installed.
        return {
          assessment: {
            runtimeId,
            verdict: "certified",
            checkedAt,
          } satisfies ExternalAgentVersionAssessment,
          receipt: receipt ?? undefined,
        }
      }

      // A managed tree Cognia owns must not drift. If it has, the receipt no
      // longer describes what would launch.
      if (receipt) {
        const observed = await host.hashTree(receipt.installRoot).catch(() => "")
        if (observed && !receiptMatchesTree(receipt, observed)) {
          return {
            assessment: {
              runtimeId,
              verdict: "unsupported",
              checkedAt,
              blockingCode: "integrity_failed",
              executablePath: receipt.entrypoint,
            },
            receipt,
          }
        }
      }

      const observation = await deps.probeVersion(entry, receipt)
      return {
        assessment: assessRuntimeVersion(
          {
            runtimeId,
            supportedRange: entry.supportedRange,
            certifiedVersions: entry.certifiedVersions,
          },
          { ...observation, parser: entry.versionProbe.parser, checkedAt }
        ),
        receipt: receipt ?? undefined,
      }
    },

    async install(runtimeId, version) {
      return stagedInstall(requireEntry(runtimeId), { version })
    },

    async checkForUpdate(runtimeId) {
      const entry = requireEntry(runtimeId)
      if (!entry.updateChannel || !deps.fetchUpdateChannel) return null

      const document = await deps.fetchUpdateChannel(entry.updateChannel.url)
      const offered = readChannelVersion(document)
      if (!offered) return null

      const receipt = await receipts.load(runtimeId)
      if (receipt?.version === offered) return null

      // A channel may offer a version the catalog carries no approved
      // distribution for. That is discoverable, not installable — surfacing it
      // as installable would invite an install that must then resolve at
      // install time.
      const approved = entry.distributions.find(
        (candidate) => candidate.version === offered && isDistributionInstallable(candidate)
      )

      return {
        runtimeId,
        fromVersion: receipt?.version,
        toVersion: offered,
        provider: approved?.provider ?? "binary",
        source: entry.updateChannel.url,
        certified: (entry.certifiedVersions ?? []).includes(offered),
        installable: Boolean(approved),
        blockingCode: approved ? undefined : "integrity_failed",
        discoveredAt: host.now().toISOString(),
      } satisfies ExternalAgentUpdateCandidate
    },

    async update(runtimeId, toVersion) {
      // Same staged sequence as a first install; the only difference is that
      // the outgoing tree becomes the retained rollback slot.
      return stagedInstall(requireEntry(runtimeId), { version: toVersion })
    },

    async rollback(runtimeId) {
      const entry = requireEntry(runtimeId)
      requireManaged(entry)

      const receipt = await receipts.load(runtimeId)
      if (!receipt?.previous) {
        throw new ExternalAgentLifecycleError(
          "runtime_missing",
          `${runtimeId} has no retained predecessor to roll back to`,
          { runtimeId }
        )
      }

      const { context, provider } = await buildContext(entry, {
        acceptProviderSwitch: true,
      })
      await getProviderAdapter(provider).rollback(context, receipt.previous)

      const restored = receiptFromRollback(receipt, host.now().toISOString())
      await receipts.save(restored)
      return restored
    },

    async uninstall(runtimeId) {
      const entry = requireEntry(runtimeId)
      requireManaged(entry)

      // Removes only the Cognia-owned root. Whether anything still DEPENDS on
      // this runtime is the lifecycle service's check, not this one's — it owns
      // the session and configuration state this layer cannot see.
      await host.removeDir(managedLayout(host, deps.rootDir, runtimeId).root)
      await receipts.delete(runtimeId)
    },
  }
}

/** Read the offered version out of a channel document, defensively. */
function readChannelVersion(document: unknown): string | undefined {
  if (!document || typeof document !== "object") return undefined
  const value = (document as { version?: unknown }).version
  return typeof value === "string" && /^\d+\.\d+\.\d+/.test(value) ? value : undefined
}
