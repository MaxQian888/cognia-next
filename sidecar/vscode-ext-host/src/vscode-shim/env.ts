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
 *
 * The rest is fixed for the host's lifetime: it runs locally in the desktop
 * app (`uiKind` Desktop, no `remoteName`), `appRoot` is the host's own
 * install directory, `shell` is the user's login shell, the log level is
 * Info, and telemetry is off, so a `TelemetryLogger` sends nothing.
 */

import * as nodePath from "node:path"
import process from "node:process"

import { LogLevel, UIKind } from "./api-types"
import { EventEmitter, Uri } from "./types"
import type { ShimDependencies } from "./index"

/** The app's URI scheme: `${env.uriScheme}://<extension id>/...` reaches a URI handler. */
export const APP_URI_SCHEME = "cognia"

/** A link as the renderer reads it: strings stay as written, a `Uri` without re-encoding. */
function linkOf(target: Uri | string): string {
  if (typeof target === "string") return target
  if (target instanceof Uri) return target.toString(true)
  return String(target)
}

/** The host's install directory (this file is `dist/vscode-shim/env.js`). */
const APP_ROOT = nodePath.resolve(__dirname, "..", "..")

/** The shell a terminal opens with when none is configured, as VS Code picks it. */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === "win32") return env.COMSPEC || "cmd.exe"
  return env.SHELL || "/bin/sh"
}

interface TelemetrySender {
  sendEventData(eventName: string, data?: Record<string, unknown>): void
  sendErrorData(error: Error, data?: Record<string, unknown>): void
  flush?(): void | Thenable<void>
}

/**
 * `env.createTelemetryLogger`: VS Code's logger with telemetry off. Nothing
 * reaches the sender; `dispose` still flushes it, as VS Code does.
 */
export function createTelemetryLogger(
  sender: TelemetrySender,
  _options?: {
    ignoreBuiltInCommonProperties?: boolean
    ignoreUnhandledErrors?: boolean
    additionalCommonProperties?: Record<string, unknown>
  }
) {
  if (
    !sender ||
    typeof sender.sendEventData !== "function" ||
    typeof sender.sendErrorData !== "function"
  ) {
    throw new TypeError("A telemetry sender needs sendEventData and sendErrorData")
  }
  const enableStates = new EventEmitter<unknown>()
  let disposed = false
  const logger = {
    isUsageEnabled: false,
    isErrorsEnabled: false,
    onDidChangeEnableStates: enableStates.event,
    logUsage(_eventName: string, _data?: Record<string, unknown>): void {},
    logError(_eventNameOrError: string | Error, _data?: Record<string, unknown>): void {},
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      enableStates.dispose()
      await sender.flush?.()
    },
  }
  return logger
}

export function createEnvNamespace(deps: ShimDependencies) {
  const { connection, extensionId } = deps
  const never = new EventEmitter<never>()
  return {
    appName: "cognia",
    appHost: "desktop",
    uriScheme: APP_URI_SCHEME,
    language: typeof navigator !== "undefined" ? (navigator.language ?? "en") : "en",
    machineId: extensionId,
    sessionId: extensionId,
    isTelemetryEnabled: false,
    isNewAppInstall: false,
    appRoot: APP_ROOT,
    uiKind: UIKind.Desktop,
    remoteName: undefined,
    shell: defaultShell(),
    logLevel: LogLevel.Info,
    // The shell, log level and telemetry setting never change while the host runs.
    onDidChangeShell: never.event,
    onDidChangeLogLevel: never.event,
    onDidChangeTelemetryEnabled: never.event,
    createTelemetryLogger,
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
