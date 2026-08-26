export const CONSOLE_BRIDGE_ORIGINALS = Symbol.for("@cognia/logging.console-bridge-originals")

/**
 * Module name the bridge logs legacy `console.*` calls under.
 *
 * Shared because `ConsoleTransport` has to recognise it: the bridge already
 * printed those args through the ORIGINAL console method (it prints
 * unconditionally, so a dropped log entry can never swallow console output), so
 * re-printing the structured entry would double every legacy call.
 */
export const CONSOLE_BRIDGE_MODULE = "legacy.console"

export interface ConsoleBridgeOriginals {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function getOriginalConsoleMethod(
  target: Console,
  method: keyof Pick<Console, "trace" | "debug" | "info" | "warn" | "error" | "log">
): (...args: unknown[]) => void {
  const originals = (target as Console & { [CONSOLE_BRIDGE_ORIGINALS]?: ConsoleBridgeOriginals })[
    CONSOLE_BRIDGE_ORIGINALS
  ]
  const original = method === "warn" || method === "error" ? originals?.[method] : undefined
  return (original ?? target[method]).bind(target)
}
