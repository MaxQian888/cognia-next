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
import { normalizeProcessExitCode, runProcessEntrypoint } from "./entry-runtime"

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
  if (role === "webclone") {
    const { runWebcloneRunner } = await import("../../../sidecar/webclone/dist/runner.js")
    await runWebcloneRunner()
    return normalizeProcessExitCode(process.exitCode)
  }
  if (role === "run-code") {
    const { runSandboxChild } =
      await import("../../../sidecar/builtin-tools/run-code/sandbox-child.mjs")
    runSandboxChild()
    return 0
  }
  if (role === "claude-probe") {
    const { resolveEmbeddedClaudeExecutable } =
      await import("../../../sidecar/dispatch/claude-executable.mjs")
    const executable = resolveEmbeddedClaudeExecutable()
    if (!executable) throw new Error("embedded Claude executable is unavailable")
    const { spawnSync } = await import("node:child_process")
    const probe = spawnSync(executable, ["--version"], { stdio: "inherit" })
    if (probe.error) throw probe.error
    return probe.status ?? 1
  }
  if (role === "codegraph-probe") {
    const { getParser } = await import("../../../sidecar/builtin-tools/code/parser.mjs")
    const parser = await getParser("typescript")
    const tree = parser.parse("const answer: number = 42")
    const ok = Boolean(tree.rootNode?.namedChildren?.length)
    process.stdout.write(`${JSON.stringify({ ok })}\n`)
    return ok ? 0 : 1
  }

  // Before the preamble, and before anything from `@/lib`: this process owns a
  // process table and nothing in the shared graph can tell by looking. Without
  // the marker the external-agent process plane refuses every stdio agent with
  // "the desktop app, or a paired Host". See ../runtime/cli-host-marker.
  const { markCliHostProcess } = await import("../runtime/cli-host-marker")
  markCliHostProcess()

  // MUST be first on the CLI path: installs a synchronous IndexedDB on the
  // global before any `@/lib` module (and the eager Dexie databases they
  // construct at import) is evaluated. See ../db/install-indexeddb.
  await import("../db/install-indexeddb")
  const { main } = await import("./index")
  return main(process.argv.slice(2))
}

void runProcessEntrypoint(boot, process, {
  // Bun 1.4 can retain an already-killed native subprocess handle even after a
  // CLI command has completed and reports no active resources. Dedicated
  // roles intentionally return from boot while stdin/IPC keeps their protocol
  // loop alive, so only the public CLI may terminate at this boundary.
  forceExitOnSuccess:
    selectRole(process.env) === "cli" &&
    Boolean(
      (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun?.isStandaloneExecutable
    ),
})
