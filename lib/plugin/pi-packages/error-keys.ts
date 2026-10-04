/**
 * Every plugin Pi package failure code (ADR-0210) → its localized message key
 * under `plugins.piPackages.errors.*`.
 *
 * One table for every surface that explains a failure: the plugin detail page
 * and Agent packages pane (resolution + operation codes), the agent editor's
 * package picker, and the chat turn-failure diagnostic for a hosted session
 * that refused to start (`PiPackageUnavailableError.code`). The English
 * sentence a runtime attaches stays in the diagnostic's `detail`; the user
 * reads the localized message keyed here.
 */

export const PI_PACKAGE_ERROR_KEYS: Readonly<Record<string, string>> = {
  // Resolution (lib/plugin/pi-packages/resolve.ts)
  "not-found": "notFound",
  "not-on-disk": "notOnDisk",
  "invalid-path": "invalidPath",
  "not-hosted": "notHosted",
  "not-prepared": "notPrepared",
  "workspace-required": "workspaceRequired",
  "double-load": "doubleLoad",
  "resolution-failed": "resolutionFailed",
  // Operations (lib/plugin/pi-packages/operations.ts)
  "desktop-only": "desktopOnly",
  "no-prepare": "noPrepare",
  declined: "declined",
  "binary-missing": "binaryMissing",
  timeout: "timeout",
  "exit-code": "exitCode",
  "marker-missing": "markerMissing",
  "needs-prepare": "needsPrepare",
  "symlinks-created": "symlinksCreated",
  "execution-failed": "executionFailed",
  // Hosted session start (PiPackageUnavailableError in pi-rpc-client.ts)
  "env-conflict": "envConflict",
  "pi-version": "piVersion",
  "bot-isolation": "botIsolation",
}

/** The message key for `code`, or `fallback` for a code this table does not know. */
export function piPackageErrorKey(code: string | null | undefined, fallback: string): string {
  if (code && Object.prototype.hasOwnProperty.call(PI_PACKAGE_ERROR_KEYS, code)) {
    return PI_PACKAGE_ERROR_KEYS[code]
  }
  return fallback
}
