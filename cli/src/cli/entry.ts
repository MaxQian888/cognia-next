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
  const role = selectRole(process.env)
  if (role === "sidecar") {
    const { runSidecarRole } = await import("../runtime/sidecar-role")
    await runSidecarRole()
    // The sidecar's readline loop keeps the process alive; this return is nominal.
    return 0
  }
  if (role === "tool-bridge") {
    // An external agent spawned us as its Cognia tool-host MCP server. Like the
    // sidecar role this must NOT load the CLI's IndexedDB preamble: the bridge
    // touches no Dexie table, and its stdout is the MCP wire.
    const { runToolBridgeRole } = await import("../runtime/tool-bridge-role")
    await runToolBridgeRole()
    // The MCP stdin loop keeps the process alive; this return is nominal.
    return 0
  }
  if (role === "mcp-relay") {
    const { runMcpRelayRole } = await import("../runtime/mcp-relay-role")
    await runMcpRelayRole()
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
