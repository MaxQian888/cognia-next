/**
 * Open VSX dependency-graph resolution.
 *
 * **Resolve the entire graph before installing anything.** Every guard below
 * exists so that a hostile or merely broken registry cannot turn one "Install"
 * click into an unbounded traversal, a surprise install of 24 other
 * extensions, or a half-installed set.
 *
 * ## `dependencies` and `bundledExtensions` are not the same thing
 *
 * This is the distinction the whole module turns on, and conflating them
 * produces a bug in *both* directions:
 *
 * - `dependencies` is VS Code's `extensionDependencies` — **hard
 *   requirements**. The extension does not function without them, so they are
 *   traversed, resolved, and installed as one atomic set.
 * - `bundledExtensions` is VS Code's `extensionPack` — a **curated bundle**.
 *   Its members are *independent installs*, not requirements.
 *
 * Treating a pack as dependencies breaks installs: `vscjava.vscode-java-pack`
 * bundles ~24 extensions, so one unavailable member would block the pack
 * entirely — even though a pack member's absence costs the pack nothing. And
 * installing them silently is exactly the outcome
 * `consent_covers_full_transitive_set` forbids: consenting to A must never
 * install 24 others the user never saw. So pack members are **reported, not
 * traversed** (`OpenVsxInstallPlan.bundled`), leaving Phase 5's UI to offer
 * them as separate, individually-consented installs.
 *
 * ## The reference shape is objects, not strings
 *
 * Live `/api/-/query` returns `dependencies` / `bundledExtensions` as
 * `{url, namespace, extension}` objects (curl-verified against
 * `vscjava.vscode-java-pack`; `esbenp.prettier-vscode`'s is `[]`). Anyone
 * reading VS Code's own `package.json` would expect `"publisher.name"`
 * strings — those are the *manifest's* spelling, not the registry's.
 * `openvsx-client.ts` already types the registry shape; this module consumes
 * that type rather than re-deriving it.
 *
 * ## Why resolution queries before it dedupes
 *
 * The obvious ordering — check the visited set, skip the query — makes
 * `version_conflict` dead code: with no version in a reference, a
 * resolve-once graph can never disagree with itself. So each *reference* is
 * resolved, and the visited map is consulted at record time. That turns the
 * single-version rule into a live consistency check against an untrusted
 * registry rather than a comment. The cost is bounded by `MAX_NODES` and
 * absorbed by `OpenVsxClient`'s positive cache, which normally serves the
 * repeat lookups of a diamond from one snapshot.
 */

import {
  getOpenVsxClient,
  type OpenVsxClient,
  type OpenVsxExtensionReference,
  type OpenVsxQueryEntry,
} from "./openvsx-client"
import {
  OpenVsxPlatformError,
  selectPlatformBuild,
  UNIVERSAL_PLATFORM,
  type OpenVsxTargetPlatform,
} from "./openvsx-platform"
import { resolveVersion } from "./openvsx-version"

// =============================================================================
// Limits
// =============================================================================

/**
 * Maximum dependency depth below the root (root is depth 0).
 *
 * Real graphs are shallow — `extensionDependencies` is almost always one hop
 * (a language pack depending on its language server). Five is generous enough
 * that no legitimate extension hits it and tight enough that a fabricated
 * chain dies early.
 */
export const MAX_DEPTH = 5

/**
 * Maximum nodes in one plan, **including the root**.
 *
 * The bound is on the plan, not on references seen, so a root advertising a
 * thousand dependencies costs at most this many registry round trips before it
 * aborts.
 */
export const MAX_NODES = 25

// =============================================================================
// Errors
// =============================================================================

export type OpenVsxDependencyErrorReason =
  /** The chain runs deeper than `MAX_DEPTH`. */
  | "depth_exceeded"
  /** The plan would exceed `MAX_NODES`. */
  | "node_limit_exceeded"
  /** A dependency has no build for the host platform (nor a universal one). */
  | "mixed_target_platform"
  /** The same extension resolved to two different versions. */
  | "version_conflict"
  /** A referenced extension isn't published / has no installable build. */
  | "unresolvable_dependency"

/** Named failure — resolution never degrades into a partial plan. */
export class OpenVsxDependencyError extends Error {
  constructor(
    readonly reason: OpenVsxDependencyErrorReason,
    message: string,
    /** The extension the failure is attributed to, when there is one. */
    readonly extensionId?: string
  ) {
    super(message)
    this.name = "OpenVsxDependencyError"
  }
}

// =============================================================================
// Plan types
// =============================================================================

/** One extension the plan will install, with its resolved build pinned. */
export interface ResolvedExtensionNode {
  /** Canonical `namespace.name`, taken from the registry-validated entry. */
  extensionId: string
  namespace: string
  name: string
  version: string
  /** Always the host platform or `universal` — never a substitution. */
  targetPlatform: OpenVsxTargetPlatform
  /** The exact `/query` entry to download, incl. `files.download` + `files.sha256`. */
  entry: OpenVsxQueryEntry
  /** Distance from the root. */
  depth: number
  /** Ids of this node's direct dependencies, all present in the plan. */
  dependencies: string[]
  /** True for the extension the user actually asked for. */
  isRoot: boolean
}

export interface OpenVsxInstallPlan {
  /** Canonical id of the requested extension. */
  rootId: string
  /** The platform every node was resolved for. */
  host: OpenVsxTargetPlatform
  /**
   * The full transitive set, **topologically ordered — dependencies before
   * dependents**. This is the set one consent prompt must cover; it is also
   * the exact install order.
   */
  nodes: ResolvedExtensionNode[]
  /**
   * The root's `extensionPack` members that the plan does **not** install.
   * Advisory: independent installs the UI may offer separately. Members that
   * are also hard dependencies are omitted — they are already in `nodes`.
   */
  bundled: OpenVsxExtensionReference[]
  /**
   * Dependency cycles encountered, each as the path that closed the loop
   * (`["a.a", "b.b", "a.a"]`). Reported rather than fatal: a cycle is the
   * registry's problem, and the visited set already makes it harmless. The
   * resulting order simply cannot be fully topological — nothing else breaks.
   */
  cycles: string[][]
}

export interface ResolveGraphOptions {
  /** Canonical `namespace.name` of the extension the user chose. */
  extensionId: string
  /** The platform to resolve for — from `resolveTargetPlatform()`. */
  host: OpenVsxTargetPlatform
  /** Metadata source. Defaults to the shared client. */
  client?: Pick<OpenVsxClient, "queryExtension">
  /** Opt in to pre-release builds. Must come from an explicit user choice. */
  allowPrerelease?: boolean
  /** Pin the **root**'s version. Dependencies always resolve to newest stable. */
  requestedVersion?: string
  maxDepth?: number
  maxNodes?: number
}

// =============================================================================
// Resolution
// =============================================================================

/** One resolved reference, before it becomes a plan node. */
interface ResolvedBuild {
  extensionId: string
  namespace: string
  name: string
  version: string
  targetPlatform: OpenVsxTargetPlatform
  entry: OpenVsxQueryEntry
}

/**
 * Resolve the full dependency closure of `extensionId`.
 *
 * @throws {OpenVsxDependencyError} on any guard violation — nothing is staged
 * or installed, by construction: this function performs no writes at all.
 * @throws {OpenVsxPlatformError} / {@link import("./openvsx-version").OpenVsxVersionError}
 * when the **root** itself has no installable build. Those failures are about
 * the extension the user picked, so their own messages are the accurate ones;
 * the equivalent failure on a *dependency* is re-attributed below.
 */
export async function resolveDependencyGraph(
  options: ResolveGraphOptions
): Promise<OpenVsxInstallPlan> {
  const client = options.client ?? getOpenVsxClient()
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const maxNodes = options.maxNodes ?? MAX_NODES
  const host = options.host

  const nodes = new Map<string, ResolvedExtensionNode>()
  /** Post-order accumulation — dependencies land before their dependents. */
  const order: string[] = []
  const cycles: string[][] = []

  /**
   * Resolve one reference to a concrete, downloadable build.
   *
   * A dependency that only ships for another platform is re-thrown as
   * `mixed_target_platform`: `selectPlatformBuild`'s own message is written
   * for the extension the user picked ("this extension has no build for
   * darwin-arm64"), which reads as nonsense when the extension in question is
   * a transitive dependency the user never named. The set cannot be installed
   * for one platform, and that is what the caller needs to be told.
   */
  async function resolveOne(refId: string, isRoot: boolean): Promise<ResolvedBuild> {
    // A platform miss is `totalSize: 0` with HTTP 200, not an error — which is
    // why the universal retry is required rather than defensive.
    const hostBuilds = (
      await client.queryExtension({
        extensionId: refId,
        targetPlatform: host,
        includeAllVersions: true,
      })
    ).extensions

    // The retry condition is "nothing *installable* for this platform", not
    // "nothing published for it". A published-but-`downloadable: false` host
    // build is not something we can install, and skipping the retry on its
    // account would hide a perfectly good universal build behind a
    // `not_downloadable` error.
    const candidates = hostBuilds.filter((e) => e.downloadable !== false)
    if (candidates.length === 0) {
      const universalBuilds = (
        await client.queryExtension({
          extensionId: refId,
          targetPlatform: UNIVERSAL_PLATFORM,
          includeAllVersions: true,
        })
      ).extensions
      // Both sets go forward: `selectPlatformBuild` owns the exact -> universal
      // -> named-error rule, and it can only apply it to what it can see.
      hostBuilds.push(...universalBuilds)
    }

    if (hostBuilds.length === 0) {
      throw new OpenVsxDependencyError(
        "unresolvable_dependency",
        `Open VSX has no ${host} or universal build of "${refId}"`,
        refId
      )
    }

    // Stability first, then the platform gate for the chosen version. Version
    // pinning is the root's privilege: a dependency reference carries no
    // version (Open VSX's `ExtensionReferenceJson` is `{url, namespace,
    // extension}`), so there is no constraint to honour for one.
    const chosen = resolveVersion(hostBuilds, {
      allowPrerelease: options.allowPrerelease,
      ...(isRoot && options.requestedVersion ? { requestedVersion: options.requestedVersion } : {}),
    })

    let build: OpenVsxQueryEntry
    try {
      build = selectPlatformBuild(
        hostBuilds.filter((e) => e.version === chosen.version),
        host
      )
    } catch (error) {
      if (!isRoot && error instanceof OpenVsxPlatformError) {
        throw new OpenVsxDependencyError(
          "mixed_target_platform",
          `Dependency "${refId}" has no build for ${host} (${error.message}). ` +
            `The whole set has to install for one platform, so this cannot proceed.`,
          refId
        )
      }
      throw error
    }

    return {
      extensionId: `${build.namespace}.${build.name}`,
      namespace: build.namespace,
      name: build.name,
      version: build.version,
      targetPlatform: (build.targetPlatform ?? UNIVERSAL_PLATFORM) as OpenVsxTargetPlatform,
      entry: build,
    }
  }

  /**
   * Depth-first visit. Returns the canonical id the reference resolved to.
   *
   * `path` carries the ancestors of the current reference, which is what
   * separates a **cycle** (the id is an ancestor) from a **diamond** (the id
   * is merely already resolved). Both stop the traversal; only the first is
   * reported.
   */
  async function visit(refId: string, depth: number, path: string[]): Promise<string> {
    // Checked before the query so a fabricated chain costs `maxDepth`
    // round trips, not one per fabricated link.
    if (depth > maxDepth) {
      throw new OpenVsxDependencyError(
        "depth_exceeded",
        `Dependency chain is deeper than the ${maxDepth}-level limit: ${[...path, refId].join(" -> ")}`,
        refId
      )
    }

    const isRoot = depth === 0
    const resolved = await resolveOne(refId, isRoot)
    const id = resolved.extensionId

    const closesCycle = path.indexOf(id)
    if (closesCycle >= 0) {
      cycles.push([...path.slice(closesCycle), id])
      return id
    }

    const existing = nodes.get(id)
    if (existing) {
      // Diamond. The registry answering with two different versions for one id
      // within a single resolution means the plan it implies is not
      // installable — two versions of an extension cannot share a directory.
      if (existing.version !== resolved.version) {
        throw new OpenVsxDependencyError(
          "version_conflict",
          `"${id}" resolves to both ${existing.version} and ${resolved.version} in this dependency graph. ` +
            `Only one version of an extension can be installed, so nothing was installed.`,
          id
        )
      }
      return id
    }

    if (nodes.size >= maxNodes) {
      throw new OpenVsxDependencyError(
        "node_limit_exceeded",
        `Installing "${options.extensionId}" would pull in more than the ${maxNodes}-extension limit`,
        id
      )
    }

    const node: ResolvedExtensionNode = {
      ...resolved,
      depth,
      dependencies: [],
      isRoot,
    }
    nodes.set(id, node)

    for (const ref of resolved.entry.dependencies ?? []) {
      const depId = await visit(referenceId(ref), depth + 1, [...path, id])
      if (!node.dependencies.includes(depId)) node.dependencies.push(depId)
    }

    order.push(id)
    return id
  }

  const rootId = await visit(options.extensionId, 0, [])

  return {
    rootId,
    host,
    nodes: order.map((id) => nodes.get(id)!),
    bundled: advisoryBundled(nodes.get(rootId)?.entry, nodes),
    cycles,
  }
}

/**
 * Spell a registry reference as a lookup id.
 *
 * Deliberately unvalidated here: `OpenVsxClient.queryExtension` applies the
 * strict `namespace` / `name` rule to whatever it is handed, so a reference
 * carrying `{namespace: "..", extension: ".."}` is rejected at the one gate
 * that owns the rule. Re-checking here would be a second copy of that rule,
 * free to drift.
 */
function referenceId(ref: OpenVsxExtensionReference): string {
  return `${ref.namespace}.${ref.extension}`
}

/**
 * The root's pack members that the plan does not already install.
 *
 * Deduped, because a pack listing the same member twice should not produce two
 * suggestions.
 */
function advisoryBundled(
  rootEntry: OpenVsxQueryEntry | undefined,
  nodes: Map<string, ResolvedExtensionNode>
): OpenVsxExtensionReference[] {
  const out: OpenVsxExtensionReference[] = []
  const seen = new Set<string>()
  for (const ref of rootEntry?.bundledExtensions ?? []) {
    const id = referenceId(ref)
    if (nodes.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(ref)
  }
  return out
}
