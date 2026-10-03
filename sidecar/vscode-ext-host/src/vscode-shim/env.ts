/**
 * `vscode.env` — environment, clipboard and opening links.
 *
 * The renderer answers the calls that reach outside the host:
 *
 *   - the clipboard, behind the extension's `clipboard:read` / `clipboard:write`
 *     permissions;
 *   - `openExternal`: a web or mail link opens in the user's browser once they
 *     agree to it, an app link (`cognia://<extension id>/...`) goes to that
 *     extension's URI handler, and a file opens in its default app when the
 *     extension may run programs (`shell:execute`);
 *   - `asExternalUri`: web links are reachable as they are; an app link becomes
 *     the deep link the operating system (or, in a browser, the app's
 *     `/deep-link` page) routes back to the extension's URI handler.
 */

import { Uri } from "./types"
import type { ShimDependencies } from "./index"

/** The app's URI scheme: `${env.uriScheme}://<extension id>/...` reaches a URI handler. */
export const APP_URI_SCHEME = "cognia"

/** A link as the renderer reads it: strings stay as written, a `Uri` without re-encoding. */
function linkOf(target: Uri | string): string {
  if (typeof target === "string") return target
  if (target instanceof Uri) return target.toString(true)
  return String(target)
}

export function createEnvNamespace(deps: ShimDependencies) {
  const { connection, extensionId } = deps
  return {
    appName: "cognia",
    appHost: "desktop",
    uriScheme: APP_URI_SCHEME,
    language: typeof navigator !== "undefined" ? (navigator.language ?? "en") : "en",
    machineId: extensionId,
    sessionId: extensionId,
    isTelemetryEnabled: false,
    isNewAppInstall: false,
    clipboard: {
      async readText(): Promise<string> {
        const text = await connection.sendRequest<string | null>("env:clipboardReadText", {
          extensionId,
        })
        return typeof text === "string" ? text : ""
      },
      async writeText(value: string): Promise<void> {
        await connection.sendRequest("env:clipboardWriteText", {
          extensionId,
          text: String(value),
        })
      },
    },
    async openExternal(target: Uri | string): Promise<boolean> {
      const opened = await connection.sendRequest<boolean>("env:openExternal", {
        extensionId,
        target: linkOf(target),
      })
      return opened === true
    },
    async asExternalUri(target: Uri): Promise<Uri> {
      const external = await connection.sendRequest<string>("env:asExternalUri", {
        extensionId,
        target: linkOf(target),
      })
      return Uri.parse(external)
    },
  }
}
