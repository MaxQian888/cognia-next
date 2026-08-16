/**
 * Creator sandbox preview lifecycle (ADR-0117, Phase 3).
 *
 * "Preview destroyed but resources leaked" is a named release blocker, so the
 * preview is built on `PluginDisposableScope` — the same ledger the plugin
 * runtime uses — rather than on ad-hoc cleanup callbacks. The scope already
 * knows how to dispose children first, wait out in-flight registrations, and
 * report what is still unresolved afterwards; that last part is the whole
 * reason it is the right substrate here.
 *
 * Hot reload is deliberately dispose-then-recreate rather than patch-in-place.
 * A partial reload would leave the previous generation's resources tracked
 * under a scope that is still open, which is exactly the leak shape the
 * teardown check is supposed to catch.
 */

import { PluginDisposableScope } from "@/lib/plugin/core/disposable-scope"
import type { CreatorArtifactKind, CreatorPreviewTeardownReport } from "@/types/creator"

export interface CreatorPreviewOptions {
  artifactKind: CreatorArtifactKind
  /** Stable id for the artifact being previewed; becomes the scope's plugin id. */
  artifactId: string
  /**
   * Mount the preview and register every resource it creates on `scope`.
   *
   * Anything not registered here is invisible to the teardown check, so the
   * contract is: register first, then use.
   */
  mount: (scope: PluginDisposableScope) => void | Promise<void>
  disposeTimeoutMs?: number
}

export class CreatorPreviewSession {
  private scope: PluginDisposableScope | null = null
  private generation = 0
  private disposed = false

  constructor(private readonly options: CreatorPreviewOptions) {}

  get artifactKind(): CreatorArtifactKind {
    return this.options.artifactKind
  }

  /** Current generation number; increments on every reload. */
  get currentGeneration(): number {
    return this.generation
  }

  get active(): boolean {
    return this.scope !== null
  }

  /** Abort signal for the current generation, or `undefined` when not mounted. */
  get signal(): AbortSignal | undefined {
    return this.scope?.signal
  }

  /**
   * Mount the first generation.
   *
   * Throws if already mounted: a second `start()` would orphan the first
   * scope's resources with no handle left to dispose them.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("Creator preview session is already disposed")
    if (this.scope) throw new Error("Creator preview is already started; use reload()")
    await this.mountGeneration()
  }

  /**
   * Tear the current generation down and mount a fresh one.
   *
   * Returns the teardown report for the *outgoing* generation, so a reload that
   * leaked is visible immediately rather than only at final teardown.
   */
  async reload(): Promise<CreatorPreviewTeardownReport> {
    if (this.disposed) throw new Error("Creator preview session is already disposed")
    const report = this.scope ? await this.teardownScope(this.scope) : cleanReport()
    this.scope = null
    await this.mountGeneration()
    return report
  }

  /** Final teardown. Idempotent — a second call reports a clean, empty result. */
  async dispose(): Promise<CreatorPreviewTeardownReport> {
    if (this.disposed || !this.scope) {
      this.disposed = true
      return cleanReport()
    }
    const report = await this.teardownScope(this.scope)
    this.scope = null
    this.disposed = true
    return report
  }

  private async mountGeneration(): Promise<void> {
    this.generation += 1
    const scope = new PluginDisposableScope(this.options.artifactId, this.generation, {
      scopeId: `creator-preview-${this.generation}`,
      disposeTimeoutMs: this.options.disposeTimeoutMs,
    })
    this.scope = scope
    try {
      await this.options.mount(scope)
    } catch (error) {
      // A mount that threw halfway may still have registered resources. Dispose
      // before rethrowing, otherwise the failed generation leaks silently.
      await scope.dispose().catch(() => undefined)
      this.scope = null
      throw error
    }
  }

  private async teardownScope(scope: PluginDisposableScope): Promise<CreatorPreviewTeardownReport> {
    const report = await scope.dispose()
    // Two independent leak signals: disposers that threw, and anything the
    // ledger still considers unresolved after the sweep. Either one means the
    // preview did not fully release, so both feed `clean`.
    const failureLabels = report.failures.map((failure) => failure.label)
    const unresolved = scope.hasUnresolvedResources() ? scope.getUnresolvedLabels() : []
    const leaked = [...new Set([...failureLabels, ...unresolved])]
    return { disposed: report.disposed, leaked, clean: leaked.length === 0 }
  }
}

function cleanReport(): CreatorPreviewTeardownReport {
  return { disposed: 0, leaked: [], clean: true }
}

/**
 * Assert a preview released everything.
 *
 * Callers use this at the end of a Creator run and in tests; a leak is a hard
 * failure rather than a warning, because a leaked preview holds host resources
 * (timers, watchers, windows) for the rest of the app's lifetime.
 */
export function assertPreviewClean(report: CreatorPreviewTeardownReport): void {
  if (report.clean) return
  throw new Error(
    `Creator preview leaked ${report.leaked.length} resource(s): ${report.leaked.join(", ")}`
  )
}
