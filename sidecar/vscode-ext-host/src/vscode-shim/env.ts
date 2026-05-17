/**
 * `vscode.env` — environment + clipboard + open external URLs.
 *
 * Every call routes through the renderer's existing `ctx.clipboard`,
 * `ctx.shell.open`, etc.
 */

import { type Uri } from "./types"
import type { ShimDependencies } from "./index"

export function createEnvNamespace(deps: ShimDependencies) {
  const { connection, extensionId } = deps
  return {
    appName: "cognia",
    appHost: "desktop",
    uriScheme: "cognia",
    language: typeof navigator !== "undefined" ? (navigator.language ?? "en") : "en",
    machineId: extensionId,
    sessionId: extensionId,
    isTelemetryEnabled: false,
    isNewAppInstall: false,
    clipboard: {
      readText: () => connection.sendRequest<string>("env:clipboardReadText", { extensionId }),
      writeText: (text: string) =>
        connection.sendRequest("env:clipboardWriteText", { extensionId, text }),
    },
    openExternal: (target: Uri | string) =>
      connection.sendRequest<boolean>("env:openExternal", {
        extensionId,
        target: typeof target === "string" ? target : target.toString(),
      }),
    asExternalUri: (target: Uri) =>
      connection.sendRequest<Uri>("env:asExternalUri", { extensionId, target }),
  }
}
