// Shared lazy code-graph resolver construction for both dispatch paths.
//
// Mirrors `src/services/lsp/lazy-resolver.ts`: the index service (and thus the
// better-sqlite3 / web-tree-sitter loads) is constructed only on first tool
// use, scoped to the session cwd, and degrades cleanly when unavailable.
// Callers MUST invoke `dispose()` at session end to close the store + watcher.

import path from "node:path"
import fs from "node:fs"

import type { ProcessSandboxScope } from "../../platform/process/exec.ts"
import { createIndexService } from "./index-service.ts"
import type { CodeGraphIndex, IndexService } from "./index-service.ts"
import { nearestRoot } from "../lsp/servers.ts"

const ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod"]

/** The send options the code-graph resolver reads. */
export interface CodeGraphSendOptions {
  cwd?: string
  builtinTools?: { codeGraph?: boolean } | null
  /** The renderer turns the watcher off with `watch: false`. */
  codeGraph?: { watch?: boolean } | null
  builtinProcessSandbox?: (ProcessSandboxScope & { writableRoots: readonly string[] }) | null
}

/** Resolve the index root: the nearest VCS/manifest ancestor of cwd, else cwd. */
export function resolveCodeGraphRoot(cwd: string): string {
  const finder = nearestRoot(ROOT_MARKERS)
  const found = finder(path.join(cwd, "__codegraph_anchor__"), {})
  return found ?? cwd
}

export function makeLazyCodeGraphResolver({
  sendOptions,
  log,
}: {
  sendOptions: CodeGraphSendOptions
  log?: (level: "info" | "warn" | "error", message: string) => void
}): { codeGraphEnabled: boolean; codeGraphResolver: CodeGraphIndex | null; dispose(): void } {
  const codeGraphEnabled = !!(sendOptions.builtinTools?.codeGraph && sendOptions.cwd)
  let service: IndexService | null = null

  const ensureService = (): IndexService => {
    if (!service) {
      // The proxy below exists only when cwd is set.
      const cwd = sendOptions.cwd as string
      let root = resolveCodeGraphRoot(cwd)
      const scope = sendOptions.builtinProcessSandbox
      if (scope) {
        const roots = scope.writableRoots.map((entry) => fs.realpathSync(entry))
        const cacheAllowed = (candidate: string): boolean => {
          const database = path.join(candidate, ".cognia", "codegraph.db")
          const target = fs.realpathSync(
            fs.existsSync(database)
              ? database
              : fs.existsSync(path.dirname(database))
                ? path.dirname(database)
                : candidate
          )
          return roots.some((allowed) => {
            const relative = path.relative(allowed, target)
            return (
              relative === "" ||
              (relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative))
            )
          })
        }
        // A nested workspace must not create an index in its parent repository.
        if (!cacheAllowed(root)) root = cwd
        if (!cacheAllowed(root))
          throw new Error("CodeGraph cache is outside authorized writable roots")
      }
      // watch defaults on; the renderer can disable it via sendOptions.codeGraph.watch.
      const watch = sendOptions.codeGraph?.watch !== false
      service = createIndexService({ root, watch })
      log?.("info", `[codegraph] indexing rooted at ${root}`)
    }
    return service
  }

  // A proxy that lazily builds the service on the first call. Every tool calls
  // `syncStale()` (async) before any sync query, so the service always exists
  // by the time a sync method runs — but ensureService() is cheap regardless.
  const codeGraphResolver: CodeGraphIndex | null = codeGraphEnabled
    ? {
        ensureIndexed: () => ensureService().ensureIndexed(),
        syncStale: () => ensureService().syncStale(),
        search: (...a) => ensureService().search(...a),
        getNode: (...a) => ensureService().getNode(...a),
        snippetFor: (...a) => ensureService().snippetFor(...a),
        callers: (...a) => ensureService().callers(...a),
        callees: (...a) => ensureService().callees(...a),
        impact: (...a) => ensureService().impact(...a),
        context: (...a) => ensureService().context(...a),
        files: () => ensureService().files(),
        status: () => ensureService().status(),
        stalenessBanner: () => ensureService().stalenessBanner(),
      }
    : null

  return {
    codeGraphEnabled,
    codeGraphResolver,
    dispose() {
      try {
        service?.dispose()
      } catch {
        /* ignore */
      }
      service = null
    },
  }
}
