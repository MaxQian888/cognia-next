/**
 * Pi extension entry Cognia loads (`-e`) into a hosted Pi session for an agent
 * that opted in to `cognia-pi-latex-workbench/latex-workbench`
 * (`plugin.json` → `piPackages[0].hostedSession.extensions`).
 *
 * It is glue, not a fork: it translates the `COGNIA_PIPKG_*` values Cognia
 * forwards into the `LATEXWB_*` binding the upstream extension reads
 * (`./env-binding.ts`), then loads the vendored adapter unchanged and calls
 * its `registerWorkbenchExtension` — the same registration the upstream
 * `packages/adapter-pi/extensions/workbench.ts` performs. The environment is
 * bound BEFORE the adapter module loads, because `WorkbenchSession.fromEnv`
 * reads it during registration.
 *
 * A user who installs the package into their own Pi (`pi install`) never runs
 * this file: Pi then reads `vendor/package.json` `pi.extensions`, and the
 * user binds the session with `LATEXWB_*` directly.
 *
 * Loaded by Pi through jiti and by Node's type stripping alike, so the file
 * keeps to erasable TypeScript. The Pi `ExtensionAPI` is forwarded untouched;
 * typing it structurally keeps Cognia's type-check free of Pi's packages.
 */

import { applyWorkbenchEnv, type WorkbenchEnvBinding } from "./env-binding.ts"

/**
 * The vendored upstream adapter, relative to this file. A non-literal
 * specifier on purpose: Cognia's `tsc` must not follow it into `vendor/`,
 * which is upstream's own strict-ESM project (ADR-0210 §7).
 */
export const ADAPTER_ENTRY = "../vendor/packages/adapter-pi/src/index.ts"

/** The slice of the upstream adapter module this entry calls. */
export interface WorkbenchAdapterModule {
  registerWorkbenchExtension(pi: unknown): unknown
}

export type WorkbenchAdapterLoader = () => Promise<WorkbenchAdapterModule>

const loadVendoredAdapter: WorkbenchAdapterLoader = async () => {
  const specifier: string = ADAPTER_ENTRY
  const mod = (await import(specifier)) as Partial<WorkbenchAdapterModule>
  if (typeof mod.registerWorkbenchExtension !== "function") {
    throw new Error(
      `${ADAPTER_ENTRY} does not export registerWorkbenchExtension — the vendored snapshot changed shape`
    )
  }
  return mod as WorkbenchAdapterModule
}

export interface CogniaWorkbenchOptions {
  /** Environment to bind (default `process.env`); modified in place. */
  env?: Record<string, string | undefined>
  /** Adapter loader (default: the vendored upstream adapter). */
  loadAdapter?: WorkbenchAdapterLoader
  /** Observer for the computed binding (tests, diagnostics). */
  onBinding?: (binding: WorkbenchEnvBinding) => void
}

/** Build the async Pi extension factory. */
export function createCogniaWorkbenchExtension(options: CogniaWorkbenchOptions = {}) {
  return async function cogniaWorkbench(pi: unknown): Promise<void> {
    const binding = applyWorkbenchEnv(options.env ?? process.env)
    options.onBinding?.(binding)
    const adapter = await (options.loadAdapter ?? loadVendoredAdapter)()
    adapter.registerWorkbenchExtension(pi)
  }
}

export default createCogniaWorkbenchExtension()
