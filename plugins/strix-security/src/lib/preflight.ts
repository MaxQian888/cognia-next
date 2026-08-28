// Pre-scan environment check: is the Docker daemon reachable and is the strix
// CLI on PATH? Runs two framed commands in a throwaway shell and reports their
// exit codes. Blocks the Start button until both are green.

import type { PluginTerminalAPI } from "@cognia/plugin-sdk"
import type { PreflightStatus } from "../types"
import { captureCommand, openPty, quietShell, safeKill, type PtyPollDeps } from "./pty"

export interface PreflightDeps extends PtyPollDeps {
  now: () => number
  randomId: () => string
}

/** Pull a version-like token out of `strix --version` output. */
export function parseStrixVersion(raw: string): string | undefined {
  const m = raw.match(/\d+\.\d+(?:\.\d+)?(?:[.-][0-9A-Za-z.]+)?/)
  return m ? m[0] : undefined
}

export async function runPreflight(
  terminal: PluginTerminalAPI,
  deps: PreflightDeps
): Promise<PreflightStatus> {
  const pty = await openPty(terminal, {})
  try {
    await quietShell(terminal, pty)
    const docker = await captureCommand(
      terminal,
      pty,
      "docker info >/dev/null 2>&1",
      deps.randomId(),
      deps
    )
    const strix = await captureCommand(terminal, pty, "strix --version", deps.randomId(), deps)
    const strixOk = strix.exitCode === 0
    return {
      docker: docker.exitCode === 0,
      strix: strixOk,
      strixVersion: strixOk ? parseStrixVersion(strix.raw) : undefined,
      checkedAt: deps.now(),
    }
  } finally {
    pty.dispose()
    await safeKill(terminal, pty.id)
  }
}
