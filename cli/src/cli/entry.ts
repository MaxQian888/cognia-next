/**
 * Executable entry for the `cognia-agent` binary. Thin wrapper: pick the role,
 * run it, map the exit code to the process. The shebang is added by the esbuild
 * bundle (see scripts/build/build-cli.mjs), not here, so the TS stays importable.
 *
 * The packaged binary is multi-call (see ./role): with `COGNIA_ROLE=sidecar` it
 * runs the Node sidecar host (the CLI self-execs it that way to launch the
 * sidecar without a system Node); otherwise it runs the CLI agent. Both branches
 * use dynamic imports so the sidecar role never pulls in the CLI's IndexedDB
 * preamble, and the CLI role still loads that preamble FIRST — before any
 * `@/lib` module — exactly as the static import used to guarantee.
 */

import { selectRole } from "./role"

async function boot(): Promise<number> {
  if (selectRole(process.env) === "sidecar") {
    const { runSidecarRole } = await import("../runtime/sidecar-role")
    await runSidecarRole()
    // The sidecar's readline loop keeps the process alive; this return is nominal.
    return 0
  }

  // MUST be first on the CLI path: installs a synchronous IndexedDB on the
  // global before any `@/lib` module (and the eager Dexie databases they
  // construct at import) is evaluated. See ../db/install-indexeddb.
  await import("../db/install-indexeddb")
  const { main } = await import("./index")
  return main(process.argv.slice(2))
}

boot()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`cognia-agent: fatal: ${err?.message ?? err}\n`)
    process.exitCode = 1
  })
