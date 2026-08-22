/**
 * Distribution providers for Cognia-managed external-Agent runtimes.
 *
 * Five providers — npm, pnpm, Bun, uv/uvx and verified binary artifacts —
 * behind one contract: prepare, verify, activate, health-check, remove,
 * rollback. Same contract for all five so a runtime can move between them
 * without the lifecycle plane learning anything new, and so provider
 * conformance is one test suite rather than five.
 *
 * The rule that shapes everything here: a managed install NEVER resolves a
 * version at install time. Package managers run in frozen mode against an
 * approved lock (`npm ci`, `pnpm install --frozen-lockfile`,
 * `bun install --frozen-lockfile`), binaries are fetched from an https URL and
 * checked against a SHA-256, and a distribution missing either is not offered
 * at all. That is the whole difference between this and the `npx -y <pkg>`
 * launches it replaces, which re-fetch on every start and can change under the
 * user without consent.
 *
 * Filesystem, process and network access arrive through {@link ProviderHost} so
 * the same logic runs on desktop (Rust-backed) and in CLI/headless (Node) and
 * is testable without either.
 *
 * @see types/agent/external-agent-lifecycle.ts
 */

import {
  ExternalAgentLifecycleError,
  JS_PROVIDER_FROZEN_INSTALL,
  isJsRuntimeProvider,
  type ExternalAgentBinaryDistribution,
  type ExternalAgentDistribution,
  type ExternalAgentJsDistribution,
  type ExternalAgentRuntimeHealth,
  type ExternalAgentRuntimeProvider,
  type ExternalAgentRuntimeRollbackSlot,
  type ExternalAgentUvxDistribution,
} from "@/types/agent/external-agent-lifecycle"

import { healthyAt, unhealthyAt } from "./receipts"

// ============================================================================
// Host port
// ============================================================================

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Everything a provider needs from the machine it runs on.
 *
 * Deliberately small and side-effect-shaped: each method does one filesystem,
 * process or network thing, so a fake host in a test is obvious rather than a
 * second implementation of the install logic.
 */
export interface ProviderHost {
  join(...parts: string[]): string
  exists(path: string): Promise<boolean>
  mkdirp(path: string): Promise<void>
  removeDir(path: string): Promise<void>
  /** Rename a directory. Must fail rather than merge if the target exists. */
  rename(from: string, to: string): Promise<void>
  writeFile(path: string, contents: string): Promise<void>
  readFile(path: string): Promise<string>
  /** SHA-256 over the file's bytes. */
  hashFile(path: string): Promise<string>
  /** Stable SHA-256 over a directory tree's contents and relative paths. */
  hashTree(path: string): Promise<string>
  exec(command: string, args: string[], options?: { cwd?: string }): Promise<ExecResult>
  /** Fetch an https URL to a local path. */
  download(url: string, destination: string): Promise<void>
  /** Unpack an archive into a directory. */
  extract(archivePath: string, destination: string, kind: "tar.gz" | "zip"): Promise<void>
  /** `<os>-<arch>` for this machine, matching a binary artifact's key. */
  platformKey(): string
  now(): Date
}

/** Where one runtime's managed directories live. */
export interface ManagedLayout {
  /** `<root>/<runtimeId>` — everything below is Cognia-owned and removable. */
  root: string
  /** The tree that is currently launched. */
  current: string
  /** The single retained predecessor. */
  previous: string
  /** Work in progress; never launched. */
  staging: string
}

export function managedLayout(
  host: ProviderHost,
  rootDir: string,
  runtimeId: string
): ManagedLayout {
  const root = host.join(rootDir, runtimeId)
  return {
    root,
    current: host.join(root, "current"),
    previous: host.join(root, "previous"),
    staging: host.join(root, "staging"),
  }
}

// ============================================================================
// Provider contract
// ============================================================================

export interface ProviderContext {
  host: ProviderHost
  layout: ManagedLayout
  runtimeId: string
  distribution: ExternalAgentDistribution
  /** Absolute path of the approved lock asset on this host, when one applies. */
  lockAssetPath?: string
}

export interface PreparedInstall {
  /** Directory the provider materialized. Always the staging directory. */
  stagedPath: string
  /** Absolute entrypoint inside `stagedPath`. */
  entrypoint: string
  /** Where the bytes came from: package spec or artifact URL. */
  source: string
  /** SHA-256 of the lock asset used, when one applied. */
  lockDigest?: string
}

export interface VerifyResult {
  ok: boolean
  treeDigest: string
  /** Non-localized reason when `ok` is false. */
  detail?: string
}

export interface RuntimeProviderAdapter {
  readonly provider: ExternalAgentRuntimeProvider
  /** Is the provider's own tool present on this host? */
  isAvailable(host: ProviderHost): Promise<boolean>
  /** Version of the provider tool itself, recorded on the receipt. */
  providerVersion(host: ProviderHost): Promise<string>
  /** Materialize the distribution into staging. Never touches `current`. */
  prepare(context: ProviderContext): Promise<PreparedInstall>
  /** Check the staged tree against the catalog before anything is activated. */
  verify(context: ProviderContext, prepared: PreparedInstall): Promise<VerifyResult>
  /** Swap staging into `current`, retaining the predecessor. */
  activate(context: ProviderContext, prepared: PreparedInstall): Promise<{ entrypoint: string }>
  /** Prove the activated tree actually runs. */
  healthCheck(context: ProviderContext, entrypoint: string): Promise<ExternalAgentRuntimeHealth>
  /** Remove every Cognia-owned directory for this runtime. */
  remove(context: ProviderContext): Promise<void>
  /** Restore the retained predecessor. */
  rollback(
    context: ProviderContext,
    slot: ExternalAgentRuntimeRollbackSlot
  ): Promise<{ entrypoint: string }>
}

// ============================================================================
// Shared staged-install engine
// ============================================================================

async function toolVersion(host: ProviderHost, command: string): Promise<string> {
  const result = await host.exec(command, ["--version"])
  if (result.code !== 0) {
    throw new ExternalAgentLifecycleError(
      "runtime_missing",
      `${command} is not usable on this host`,
      { command, code: result.code }
    )
  }
  return result.stdout.trim()
}

async function toolAvailable(host: ProviderHost, command: string): Promise<boolean> {
  try {
    const result = await host.exec(command, ["--version"])
    return result.code === 0
  } catch {
    return false
  }
}

/** Empty the staging directory so a retried install never inherits a half-tree. */
async function resetStaging(host: ProviderHost, layout: ManagedLayout): Promise<void> {
  await host.removeDir(layout.staging)
  await host.mkdirp(layout.staging)
}

/**
 * Swap staging into `current`, keeping the outgoing tree as the rollback slot.
 *
 * Three renames rather than one: POSIX will not rename a directory over an
 * existing one, so the old `previous` goes first, `current` becomes `previous`,
 * and only then does staging become `current`. The window between the second
 * and third rename is the one moment there is no `current` — which is why
 * nothing verifies or health-checks here. Both already happened against the
 * staged tree.
 */
async function swapIntoPlace(host: ProviderHost, layout: ManagedLayout): Promise<void> {
  await host.removeDir(layout.previous)
  if (await host.exists(layout.current)) {
    await host.rename(layout.current, layout.previous)
  }
  await host.rename(layout.staging, layout.current)
}

/** Move `current` back out of the way and restore `previous`. */
async function swapBack(host: ProviderHost, layout: ManagedLayout): Promise<void> {
  if (!(await host.exists(layout.previous))) {
    throw new ExternalAgentLifecycleError(
      "runtime_missing",
      "no retained predecessor to roll back to"
    )
  }
  await host.removeDir(layout.staging)
  if (await host.exists(layout.current)) {
    await host.rename(layout.current, layout.staging)
  }
  await host.rename(layout.previous, layout.current)
  await host.removeDir(layout.staging)
}

/**
 * Run the entrypoint's version probe as a health check.
 *
 * "It reports a version" is a weak claim, and deliberately so: it proves the
 * tree is executable and its dependencies resolve, which is exactly the class
 * of failure a frozen install can still produce (a missing native prebuild, a
 * broken bin shim). Whether that version BEHAVES is a runtime property no
 * install-time check can establish, and pretending otherwise would read as
 * coverage this does not have.
 */
async function probeHealth(
  host: ProviderHost,
  entrypoint: string,
  args: string[] = ["--version"]
): Promise<ExternalAgentRuntimeHealth> {
  const checkedAt = host.now().toISOString()
  try {
    const result = await host.exec(entrypoint, args)
    if (result.code !== 0) {
      return unhealthyAt(
        checkedAt,
        "entrypoint-failed",
        `probe exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`
      )
    }
    if (!result.stdout.trim()) {
      return unhealthyAt(checkedAt, "entrypoint-silent", "probe produced no output")
    }
    return healthyAt(checkedAt)
  } catch (error) {
    return unhealthyAt(
      checkedAt,
      "entrypoint-unlaunchable",
      error instanceof Error ? error.message : String(error)
    )
  }
}

async function removeManagedRoot(context: ProviderContext): Promise<void> {
  // Only the Cognia-owned root. A `system` runtime belongs to the user's
  // package manager and is never touched by any of this.
  await context.host.removeDir(context.layout.root)
}

async function rollbackShared(
  context: ProviderContext,
  slot: ExternalAgentRuntimeRollbackSlot
): Promise<{ entrypoint: string }> {
  await swapBack(context.host, context.layout)
  return { entrypoint: slot.entrypoint }
}

// ============================================================================
// JavaScript package managers
// ============================================================================

function jsPackageSpec(distribution: ExternalAgentJsDistribution): string {
  return `${distribution.packageName}@${distribution.version}`
}

/**
 * Build the minimal `package.json` a frozen install needs.
 *
 * Written rather than shipped so the dependency and the catalog can never
 * disagree about which version is being installed: this file is generated FROM
 * the catalog entry the lock was approved against.
 */
function stagedManifest(distribution: ExternalAgentJsDistribution): string {
  return `${JSON.stringify(
    {
      name: `cognia-managed-${distribution.packageName.replace(/[^a-z0-9]+/gi, "-")}`,
      private: true,
      version: "0.0.0",
      dependencies: { [distribution.packageName]: distribution.version },
    },
    null,
    2
  )}\n`
}

export function createJsProviderAdapter(provider: "npm" | "pnpm" | "bun"): RuntimeProviderAdapter {
  const plan = JS_PROVIDER_FROZEN_INSTALL[provider]

  return {
    provider,

    isAvailable: (host) => toolAvailable(host, plan.command),
    providerVersion: (host) => toolVersion(host, plan.command),

    async prepare(context) {
      const distribution = context.distribution as ExternalAgentJsDistribution
      const { host, layout } = context

      if (!context.lockAssetPath) {
        // Reaching here means the catalog offered a distribution the gate
        // should have refused; fail loudly rather than resolving a range.
        throw new ExternalAgentLifecycleError(
          "integrity_failed",
          `${context.runtimeId}: no approved lock asset, refusing to resolve at install time`,
          { runtimeId: context.runtimeId, provider }
        )
      }

      await resetStaging(host, layout)

      const lockContents = await host.readFile(context.lockAssetPath)
      await host.writeFile(host.join(layout.staging, "package.json"), stagedManifest(distribution))
      await host.writeFile(host.join(layout.staging, plan.lockfile), lockContents)

      const result = await host.exec(plan.command, [...plan.args], { cwd: layout.staging })
      if (result.code !== 0) {
        throw new ExternalAgentLifecycleError(
          "integrity_failed",
          `${plan.command} ${plan.args.join(" ")} failed: ${result.stderr.trim().slice(0, 300)}`,
          { runtimeId: context.runtimeId, provider }
        )
      }

      return {
        stagedPath: layout.staging,
        entrypoint: host.join(layout.staging, distribution.entrypoint),
        source: jsPackageSpec(distribution),
        lockDigest: await host.hashFile(context.lockAssetPath),
      }
    },

    async verify(context, prepared) {
      const distribution = context.distribution as ExternalAgentJsDistribution
      const { host } = context
      const treeDigest = await host.hashTree(prepared.stagedPath)

      if (!(await host.exists(prepared.entrypoint))) {
        return {
          ok: false,
          treeDigest,
          detail: `entrypoint ${distribution.entrypoint} is missing from the installed tree`,
        }
      }

      if (prepared.lockDigest !== distribution.lockAsset.sha256) {
        return {
          ok: false,
          treeDigest,
          detail: "lock asset does not match the digest the catalog approved",
        }
      }

      return { ok: true, treeDigest }
    },

    async activate(context) {
      const distribution = context.distribution as ExternalAgentJsDistribution
      await swapIntoPlace(context.host, context.layout)
      return {
        entrypoint: context.host.join(context.layout.current, distribution.entrypoint),
      }
    },

    healthCheck: (context, entrypoint) => probeHealth(context.host, entrypoint),
    remove: removeManagedRoot,
    rollback: rollbackShared,
  }
}

// ============================================================================
// uv / uvx
// ============================================================================

export const uvxProviderAdapter: RuntimeProviderAdapter = {
  provider: "uvx",

  isAvailable: (host) => toolAvailable(host, "uv"),
  providerVersion: (host) => toolVersion(host, "uv"),

  async prepare(context) {
    const distribution = context.distribution as ExternalAgentUvxDistribution
    const { host, layout } = context

    if (!context.lockAssetPath) {
      throw new ExternalAgentLifecycleError(
        "integrity_failed",
        `${context.runtimeId}: no approved uv.lock, refusing to resolve at install time`,
        { runtimeId: context.runtimeId, provider: "uvx" }
      )
    }

    await resetStaging(host, layout)
    await host.writeFile(
      host.join(layout.staging, "uv.lock"),
      await host.readFile(context.lockAssetPath)
    )

    // `--frozen` is the uv equivalent of the JS frozen flags: install exactly
    // what the lock names and fail rather than re-resolve.
    const result = await host.exec(
      "uv",
      [
        "pip",
        "install",
        "--frozen",
        "--target",
        ".",
        `${distribution.packageName}==${distribution.version}`,
      ],
      { cwd: layout.staging }
    )
    if (result.code !== 0) {
      throw new ExternalAgentLifecycleError(
        "integrity_failed",
        `uv pip install failed: ${result.stderr.trim().slice(0, 300)}`,
        { runtimeId: context.runtimeId, provider: "uvx" }
      )
    }

    return {
      stagedPath: layout.staging,
      entrypoint: host.join(layout.staging, distribution.entrypoint),
      source: `${distribution.packageName}==${distribution.version}`,
      lockDigest: await host.hashFile(context.lockAssetPath),
    }
  },

  async verify(context, prepared) {
    const distribution = context.distribution as ExternalAgentUvxDistribution
    const treeDigest = await context.host.hashTree(prepared.stagedPath)

    if (!(await context.host.exists(prepared.entrypoint))) {
      return {
        ok: false,
        treeDigest,
        detail: `entrypoint ${distribution.entrypoint} is missing from the installed tree`,
      }
    }
    if (prepared.lockDigest !== distribution.lockAsset.sha256) {
      return { ok: false, treeDigest, detail: "uv.lock does not match the approved digest" }
    }
    return { ok: true, treeDigest }
  },

  async activate(context) {
    const distribution = context.distribution as ExternalAgentUvxDistribution
    await swapIntoPlace(context.host, context.layout)
    return { entrypoint: context.host.join(context.layout.current, distribution.entrypoint) }
  },

  healthCheck: (context, entrypoint) => probeHealth(context.host, entrypoint),
  remove: removeManagedRoot,
  rollback: rollbackShared,
}

// ============================================================================
// Verified binary artifacts
// ============================================================================

export const binaryProviderAdapter: RuntimeProviderAdapter = {
  provider: "binary",

  // Nothing to install; the host itself is the provider.
  isAvailable: async () => true,
  providerVersion: async (host) => `host:${host.platformKey()}`,

  async prepare(context) {
    const distribution = context.distribution as ExternalAgentBinaryDistribution
    const { host, layout } = context
    const platformKey = host.platformKey()
    const artifact = distribution.artifacts.find((entry) => entry.platformKey === platformKey)

    if (!artifact) {
      throw new ExternalAgentLifecycleError(
        "platform_unsupported",
        `${context.runtimeId} publishes no artifact for ${platformKey}`,
        { runtimeId: context.runtimeId, platformKey }
      )
    }
    if (!artifact.url.startsWith("https://")) {
      throw new ExternalAgentLifecycleError(
        "integrity_failed",
        `${context.runtimeId}: artifact is not served over https`,
        { runtimeId: context.runtimeId }
      )
    }

    await resetStaging(host, layout)

    const downloadPath = host.join(layout.staging, "artifact.download")
    await host.download(artifact.url, downloadPath)

    // Checked BEFORE unpacking: extracting an unverified archive is already
    // executing attacker-chosen paths on disk.
    const digest = await host.hashFile(downloadPath)
    if (digest !== artifact.integrity.sha256) {
      await host.removeDir(layout.staging)
      throw new ExternalAgentLifecycleError(
        "integrity_failed",
        `${context.runtimeId}: artifact hashes to ${digest}, catalog says ${artifact.integrity.sha256}`,
        { runtimeId: context.runtimeId }
      )
    }

    if (artifact.archive !== "none") {
      await host.extract(downloadPath, layout.staging, artifact.archive)
    }

    return {
      stagedPath: layout.staging,
      entrypoint: host.join(layout.staging, artifact.entrypoint),
      source: artifact.url,
    }
  },

  async verify(context, prepared) {
    const treeDigest = await context.host.hashTree(prepared.stagedPath)
    if (!(await context.host.exists(prepared.entrypoint))) {
      return { ok: false, treeDigest, detail: "entrypoint is missing from the unpacked artifact" }
    }
    return { ok: true, treeDigest }
  },

  async activate(context) {
    const distribution = context.distribution as ExternalAgentBinaryDistribution
    const platformKey = context.host.platformKey()
    const artifact = distribution.artifacts.find((entry) => entry.platformKey === platformKey)
    await swapIntoPlace(context.host, context.layout)
    return {
      entrypoint: context.host.join(context.layout.current, artifact?.entrypoint ?? "bin"),
    }
  },

  healthCheck: (context, entrypoint) => probeHealth(context.host, entrypoint),
  remove: removeManagedRoot,
  rollback: rollbackShared,
}

// ============================================================================
// Registry
// ============================================================================

const ADAPTERS: Record<ExternalAgentRuntimeProvider, RuntimeProviderAdapter> = {
  npm: createJsProviderAdapter("npm"),
  pnpm: createJsProviderAdapter("pnpm"),
  bun: createJsProviderAdapter("bun"),
  uvx: uvxProviderAdapter,
  binary: binaryProviderAdapter,
}

export function getProviderAdapter(provider: ExternalAgentRuntimeProvider): RuntimeProviderAdapter {
  const adapter = ADAPTERS[provider]
  if (!adapter) {
    throw new ExternalAgentLifecycleError(
      "runtime_missing",
      `no provider adapter for "${provider}"`,
      { provider }
    )
  }
  return adapter
}

/** Which providers can actually run here right now. */
export async function availableProviders(
  host: ProviderHost
): Promise<ExternalAgentRuntimeProvider[]> {
  const found: ExternalAgentRuntimeProvider[] = []
  for (const [provider, adapter] of Object.entries(ADAPTERS)) {
    if (await adapter.isAvailable(host)) {
      found.push(provider as ExternalAgentRuntimeProvider)
    }
  }
  return found
}

/** Every provider the registry knows, for conformance testing. */
export function allProviderAdapters(): RuntimeProviderAdapter[] {
  return Object.values(ADAPTERS)
}

export { isJsRuntimeProvider }
