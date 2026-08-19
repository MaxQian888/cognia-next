export interface EntrypointProcess {
  stderr: { write(text: string): unknown }
  exit(code: number): never
  exitCode: number | string | null | undefined
}

/**
 * Settle the executable process after boot. Fatal startup failures must use
 * `exit()` rather than only setting `exitCode`: database and runtime imports
 * may already own live timers that would otherwise strand the process until
 * the native supervisor's readiness watchdog fires.
 */
export async function runProcessEntrypoint(
  boot: () => Promise<number>,
  proc: EntrypointProcess = process
): Promise<void> {
  try {
    proc.exitCode = await boot()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    proc.stderr.write(`cognia-agent: fatal: ${message}\n`)
    proc.exit(1)
  }
}
