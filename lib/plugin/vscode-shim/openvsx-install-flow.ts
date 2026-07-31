/**
 * Two-phase install of an Open VSX dependency graph.
 *
 * **Stage everything, then commit everything.** Every node is downloaded,
 * checksum-verified, parsed, and permission-inferred *before* the first row is
 * written; if any commit then fails, the whole set is rolled back. A partially
 * installed graph is worse than no install: the root activates, its dependency
 * is missing, and the failure surfaces later as an unrelated-looking runtime
 * error.
 *
 * ## Why this implements `{ getPlugin, installPlugin }`
 *
 * `runMarketplaceInstall` is not called with the cognia registry client here —
 * that client resolves *cognia* manifests from a *cognia* registry, and an Open
 * VSX extension is neither. But its `client` seam
 * (`install-flow.ts`'s `RunMarketplaceInstallOpts["client"]`) is only those two
 * methods, and satisfying them buys the entire
 * Conflict → Dependencies → Permission → Binaries → Config consent chain, the
 * dialogs, the rollback hook, and `usePluginPreInstall` — unchanged. The
 * alternative was a parallel consent chain that would drift from the real one
 * the first time either side changed.
 *
 * The seam also happens to map exactly onto the two phases:
 *
 * - `getPlugin(id)` → **stage**: resolve the graph, download + verify every
 *   node, and return one aggregate manifest describing the whole set.
 * - `installPlugin(id)` → **commit**: write them all, or none.
 *
 * ## 🔴 `getPlugin` is called twice per install
 *
 * Once by `use-plugin-pre-install.ts` (to compute `totalSteps` before any
 * dialog renders) and again by `install-flow.ts` (to resolve the manifest).
 * Staging is what downloads the bytes, so **without memoisation every install
 * downloads the whole graph twice**. That is a correctness bug, not a
 * performance one, and `two_getPlugin_calls_download_once` pins it.
 *
 * ## Why the bytes have to be downloaded before consent
 *
 * `inferPermissions` is a `@babel/parser` AST walk over the extension's main
 * bundle. Deriving permissions from `files.manifest` alone would leave
 * `resolveMainBundlePath` returning `null`, at which point `inferPermissions`
 * early-returns `confidence: "high"` — a value that means "theme-only, no code
 * to walk". The user would be shown a *high-confidence* claim of two
 * permissions and get eight. So the download precedes consent; what does not
 * precede consent is any write, which is the property that actually matters
 * (`partial_install_never_persisted`).
 */

import { loggers } from "@cognia/logging"
import { deletePlugin } from "@/lib/db/plugins"
import { readBinaryFile, removeFile } from "@/lib/file/file-operations"
import { canUseTauriInvoke } from "@/lib/native/utils"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginManifest, PluginPermission } from "@/types/plugin"
import type { RunMarketplaceInstallOpts } from "@/lib/plugin/marketplace/install-flow"
import {
  commitVscodeExtension,
  prepareVscodeExtension,
  type PreparedVscodeExtension,
} from "./install-vscode-extension"
import {
  resolveDependencyGraph,
  type OpenVsxInstallPlan,
  type ResolvedExtensionNode,
} from "./openvsx-dep-resolver"
import { resolveTargetPlatform, type OpenVsxTargetPlatform } from "./openvsx-platform"
import type { OpenVsxQueryEntry } from "./openvsx-client"

// =============================================================================
// Types
// =============================================================================

/** What the Rust `plugin_vscode_download_vsix` command returns. */
export interface DownloadedVsix {
  tempPath: string
  sha256Hex: string
  sizeBytes: number
}

/** One node, downloaded and parsed, not yet written anywhere. */
export interface StagedExtension {
  node: ResolvedExtensionNode
  prepared: PreparedVscodeExtension
  /** The Rust-staged `.vsix`; consumed (and deleted) by the commit. */
  tempPath: string
}

/** A fully staged graph, ready to review and then commit. */
export interface StagedGraph {
  plan: OpenVsxInstallPlan
  /** Install order — dependencies before dependents. */
  staged: StagedExtension[]
  /**
   * One manifest standing in for the whole set: the root's, with the
   * transitive union of every node's inferred permissions.
   */
  manifest: PluginManifest
}

/**
 * Injection seams. Every default is the real implementation; tests replace
 * them rather than mocking the Tauri/Dexie world wholesale.
 */
export interface OpenVsxInstallFlowDeps {
  resolveHost?: () => Promise<OpenVsxTargetPlatform>
  resolveGraph?: typeof resolveDependencyGraph
  download?: (entry: OpenVsxQueryEntry) => Promise<DownloadedVsix>
  readBytes?: (path: string) => Promise<Uint8Array>
  prepare?: typeof prepareVscodeExtension
  commit?: typeof commitVscodeExtension
  /** Inverse of `commit`. Used only to roll a failed graph back. */
  uninstall?: (row: PluginRow) => Promise<void>
  allowPrerelease?: boolean
  requestedVersion?: string
}

// =============================================================================
// Download + staging
// =============================================================================

/**
 * Fetch one node's `.vsix` through Rust and hand the bytes back to JS.
 *
 * Rust does the fetching because `proxyFetch`'s Rust backend returns
 * `body: String` — structurally unable to carry binary — so a TS-direct
 * download would silently bypass the user's configured proxy. Rust streams to
 * a temp file, hashes as it writes, and enforces the 80 MB marketplace cap.
 */
async function defaultDownload(entry: OpenVsxQueryEntry): Promise<DownloadedVsix> {
  if (!canUseTauriInvoke()) {
    throw new Error(
      "Installing extensions from Open VSX requires the Cognia desktop app — the download runs in the Rust backend so it can honour your proxy settings and verify checksums."
    )
  }
  if (!entry.files.sha256) {
    // Not defensive: `files.sha256` is a URL to a digest file, and a missing
    // one means there is nothing to verify against. Installing unverified
    // executable bytes because the registry forgot a field is not a trade we
    // make.
    throw new Error(
      `Open VSX published no sha256 digest for ${entry.namespace}.${entry.name}@${entry.version}; refusing to install unverified bytes`
    )
  }
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<DownloadedVsix>("plugin_vscode_download_vsix", {
    downloadUrl: entry.files.download,
    sha256Url: entry.files.sha256,
  })
}

/** The exact inverse of `commitVscodeExtension`: the row and the directory. */
async function defaultUninstall(row: PluginRow): Promise<void> {
  // Order matters: drop the row first. A leftover directory with no row is
  // inert; a row pointing at a deleted directory is a plugin the manager will
  // try to load and fail on.
  await deletePlugin(row.id)
  if (row.path && !row.path.startsWith("vsix://")) {
    await removeFile(row.path, { recursive: true })
  }
}

/**
 * Download, verify, and parse every node of `plan`.
 *
 * The checksum is computed twice on purpose — once by Rust while streaming,
 * once by `installVsix` over the bytes JS actually parsed. Comparing them
 * closes the gap between "the file Rust verified" and "the bytes we inferred
 * permissions from", which are only the same file if nothing rewrote it in
 * between.
 */
export async function stageGraph(
  plan: OpenVsxInstallPlan,
  deps: OpenVsxInstallFlowDeps = {}
): Promise<StagedGraph> {
  const download = deps.download ?? defaultDownload
  const readBytes = deps.readBytes ?? readBinaryFile
  const prepare = deps.prepare ?? prepareVscodeExtension

  const staged: StagedExtension[] = []
  try {
    for (const node of plan.nodes) {
      const downloaded = await download(node.entry)
      const bytes = await readBytes(downloaded.tempPath)
      // The commit installs from the file Rust already verified rather than
      // shipping these bytes back as base64.
      //
      // `node.targetPlatform` is passed through so the installed manifest
      // records the platform this build was *resolved for*. The update check
      // re-queries with it: a `universal` fallback install must keep asking
      // for `universal`, not for whatever the asking machine happens to be.
      const prepared: PreparedVscodeExtension = {
        ...(await prepare(bytes, "openvsx", node.targetPlatform)),
        stagedPath: downloaded.tempPath,
      }

      if (prepared.vsix.sha256 !== downloaded.sha256Hex) {
        throw new Error(
          `Checksum disagreement for ${node.extensionId}: Rust verified ${downloaded.sha256Hex} ` +
            `but the bytes the renderer parsed hash to ${prepared.vsix.sha256}`
        )
      }
      if (prepared.adapted.manifest.id !== node.extensionId) {
        // The registry said one thing, the archive's own package.json another.
        // Installing under the registry's id would let a namespace serve an
        // extension that impersonates a different one.
        throw new Error(
          `Open VSX lists "${node.extensionId}" but the .vsix declares "${prepared.adapted.manifest.id}"`
        )
      }
      staged.push({ node, prepared, tempPath: downloaded.tempPath })
    }
  } catch (error) {
    // Nothing is persisted yet, so "rollback" is just not leaving 80 MB
    // temp files behind per node.
    await discardStaged(staged)
    throw error
  }

  return { plan, staged, manifest: aggregateManifest(plan, staged) }
}

/** Drop staged temp files. Best-effort: a failed cleanup must not mask the cause. */
async function discardStaged(staged: StagedExtension[]): Promise<void> {
  for (const item of staged) {
    try {
      await removeFile(item.tempPath)
    } catch (error) {
      loggers.plugin.warn("Failed to clean up a staged Open VSX download", {
        extension: item.node.extensionId,
        tempPath: item.tempPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Collapse the staged set into the one manifest the consent chain reviews.
 *
 * The union of `permissions` is the whole point: the permission step is shown
 * once, for the root, so it has to describe everything the click will install.
 * A dependency's `child_process.spawn` must appear in the root's prompt or the
 * consent is a lie.
 *
 * What this deliberately does **not** set is `dependencies`. That field is
 * cognia's plugin-dependency mechanism, and `runMarketplaceInstall` gates on
 * it: every id in it that isn't already installed cancels the install at the
 * `dependencies` stage. Our dependencies are not missing — they are staged and
 * about to be installed by us, in this same call. Two mechanisms, one word.
 */
function aggregateManifest(plan: OpenVsxInstallPlan, staged: StagedExtension[]): PluginManifest {
  const root = staged.find((s) => s.node.extensionId === plan.rootId)
  if (!root) {
    throw new Error(`Staged graph for "${plan.rootId}" is missing its root extension`)
  }

  const permissions = new Set<PluginPermission>()
  for (const item of staged) {
    for (const permission of item.prepared.adapted.manifest.permissions ?? []) {
      permissions.add(permission)
    }
  }

  return {
    ...root.prepared.adapted.manifest,
    permissions: [...permissions],
  }
}

// =============================================================================
// Commit
// =============================================================================

/**
 * In-process serialisation of the commit phase.
 *
 * Two overlapping graphs committing concurrently would each decide what to
 * roll back from a view of the plugin table the other is mutating: A commits
 * shared dependency D, B sees D installed and marks it "pre-existing, don't
 * touch", then A fails and removes D — leaving B pointing at a directory that
 * no longer exists. Serialising the commit means every run observes a settled
 * table.
 *
 * Only the commit is serialised. Staging writes nothing, so downloads still
 * overlap freely, and the lock is never held across a consent dialog.
 */
let commitQueue: Promise<unknown> = Promise.resolve()

function withCommitLock<T>(task: () => Promise<T>): Promise<T> {
  const run = commitQueue.then(task, task)
  // Keep the chain alive regardless of outcome; the caller owns the rejection.
  commitQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * Write every staged node, or none.
 *
 * Rollback only removes what *this* call created. A node that was already
 * installed is left alone: the user installed it before, possibly deliberately,
 * and a failed install of something else is no reason to take it away.
 */
export async function commitGraph(
  graph: StagedGraph,
  deps: OpenVsxInstallFlowDeps = {}
): Promise<PluginRow[]> {
  const commit = deps.commit ?? commitVscodeExtension
  const uninstall = deps.uninstall ?? defaultUninstall

  return withCommitLock(async () => {
    const created: PluginRow[] = []
    try {
      for (const item of graph.staged) {
        created.push(await commit(item.prepared))
      }
      return created
    } catch (error) {
      await rollback(created, uninstall)
      // Anything not yet committed still has a temp file to clean up.
      await discardStaged(graph.staged.slice(created.length))
      throw error
    }
  })
}

async function rollback(
  created: PluginRow[],
  uninstall: (row: PluginRow) => Promise<void>
): Promise<void> {
  // Reverse order — dependents before their dependencies, mirroring the
  // install order.
  for (const row of [...created].reverse()) {
    try {
      await uninstall(row)
    } catch (error) {
      // Report and keep going: one stuck directory must not strand the rest of
      // the graph half-installed.
      loggers.plugin.error(
        "Failed to roll back an Open VSX extension after a failed graph install",
        {
          extension: row.id,
          error: error instanceof Error ? error.message : String(error),
        }
      )
    }
  }
}

// =============================================================================
// The `{ getPlugin, installPlugin }` seam
// =============================================================================

type MarketplaceClientSeam = RunMarketplaceInstallOpts["client"]

export interface OpenVsxInstallClient extends MarketplaceClientSeam {
  /** Drop the staged graph and its temp files. For "user cancelled" paths. */
  discard: () => Promise<void>
}

/**
 * Build the client `usePluginPreInstall` / `runMarketplaceInstall` drive.
 *
 * The stage holds **one** graph at a time. Each entry pins up to 80 MB of
 * `.vsix` bytes in memory, so keeping a history of them would OOM the webview
 * after a few browsing clicks; staging a different root evicts the previous
 * one, which also matches how the UI is used (one install at a time).
 */
export function createOpenVsxInstallClient(
  deps: OpenVsxInstallFlowDeps = {}
): OpenVsxInstallClient {
  /**
   * The memo that keeps the double `getPlugin` from double-downloading. Keyed
   * by root id and holding the in-flight promise (not its result), so two
   * calls that overlap share the same download rather than racing.
   */
  let stage: { rootId: string; graph: Promise<StagedGraph> } | null = null

  async function stageFor(extensionId: string): Promise<StagedGraph> {
    if (stage?.rootId === extensionId) return stage.graph

    if (stage) await discardStage()

    const pending = (async () => {
      const host = await (deps.resolveHost ?? resolveTargetPlatform)()
      const plan = await (deps.resolveGraph ?? resolveDependencyGraph)({
        extensionId,
        host,
        allowPrerelease: deps.allowPrerelease,
        requestedVersion: deps.requestedVersion,
      })
      return stageGraph(plan, deps)
    })()

    stage = { rootId: extensionId, graph: pending }
    // A failed staging must not be memoised as a permanent "no" — the user
    // retrying after fixing their network should re-download.
    pending.catch(() => {
      if (stage?.graph === pending) stage = null
    })
    return pending
  }

  async function discardStage(): Promise<void> {
    const current = stage
    stage = null
    if (!current) return
    try {
      await discardStaged((await current.graph).staged)
    } catch {
      // The staging itself failed, so there is nothing staged to discard.
    }
  }

  return {
    async getPlugin(id) {
      const graph = await stageFor(id)
      return { manifest: graph.manifest, name: graph.manifest.name }
    },

    async installPlugin(id, version) {
      const graph = await stageFor(id)

      // The consent the user just gave was computed from *this* staged graph.
      // Installing a different version than the one whose permissions were
      // reviewed would make the whole prompt meaningless, so a disagreement is
      // a hard error rather than a re-stage.
      if (version && version !== graph.manifest.version) {
        throw new Error(
          `Refusing to install ${id}@${version}: the permissions you reviewed were resolved from ` +
            `${graph.manifest.version}. Reopen the extension to install a different version.`
        )
      }

      try {
        return await commitGraph(graph, deps)
      } finally {
        // Committed or rolled back, the bytes are spent either way.
        stage = null
      }
    },

    discard: discardStage,
  }
}
