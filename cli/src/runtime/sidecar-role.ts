/**
 * Sidecar role for the packaged binary.
 *
 * When the binary is launched with `COGNIA_ROLE=sidecar` (the CLI self-execs it
 * this way — see {@link resolveSpawnTarget}), it must run the Node sidecar host
 * instead of the CLI. The sidecar bundle (`sidecar/claude-host.mjs`) starts its
 * readline host loop as a top-level side effect on evaluation, so importing it
 * is enough to launch it — the open stdin interface then keeps the process
 * alive. Collaborators are injected so this unit-tests without a real import.
 */

import { pathToFileURL } from "node:url"

import { resolveSidecarScript } from "./bootstrap"

export interface SidecarRoleDeps {
  /** Locate the sidecar script. Defaults to {@link resolveSidecarScript}. */
  resolveScript?: typeof resolveSidecarScript
  /** Dynamic-import a module by URL. Injected for tests. */
  importer?: (url: string) => Promise<unknown>
}

/** Start the sidecar host in this process by importing its bundle. */
export async function runSidecarRole(deps: SidecarRoleDeps = {}): Promise<void> {
  const resolve = deps.resolveScript ?? resolveSidecarScript
  const importer = deps.importer ?? ((url: string) => import(url))
  const script = resolve()
  await importer(pathToFileURL(script).href)
}
