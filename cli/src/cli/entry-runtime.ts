export interface EntrypointProcess {
  stderr: { write(text: string): unknown }
  exit(code: number): never
  exitCode: number | string | null | undefined
}

/** Convert Node's permissive exit-code property into the CLI's numeric contract. */
export function normalizeProcessExitCode(exitCode: EntrypointProcess["exitCode"]): number {
  if (exitCode == null) return 0
  if (typeof exitCode === "number") return exitCode
  const parsed = Number(exitCode)
  return Number.isInteger(parsed) ? parsed : 1
}

/**
 * Settle the executable process after boot. Fatal startup failures must use
 * `exit()` rather than only setting `exitCode`: database and runtime imports
 * may already own live timers that would otherwise strand the process until
 * the native supervisor's readiness watchdog fires.
 */
export async function runProcessEntrypoint(
  boot: () => Promise<number>,
  proc: EntrypointProcess = process,
  options: { forceExitOnSuccess?: boolean } = {}
): Promise<void> {
  let code: number
  try {
    code = await boot()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    proc.stderr.write(`cognia-agent: fatal: ${message}\n`)
    proc.exit(1)
  }
  proc.exitCode = code
  if (options.forceExitOnSuccess) proc.exit(code)
}
