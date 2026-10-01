import { shellQuote } from "@/lib/mcp/config-transfer"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

export const KIMI_REVIEWED_VERSION = "2.1.1"

export type KimiManagementAction =
  | "install"
  | "restore"
  | "uninstall"
  | "upgrade"
  | "doctor"
  | "native"
  | "web"
  | "migrate"
  | "export"

/**
 * User-visible POSIX recipes, not external-agent launch requests. Only the
 * state directory is copied from configuration; API keys and other secret
 * environment values must never become clipboard or terminal command text.
 */
export function kimiManagementCommand(
  agent: Pick<ExternalAgentConfig, "process">,
  action: KimiManagementAction,
  sessionId?: string
): string {
  if (action === "install" || action === "restore") {
    return `npm install --global @moonshot-ai/kimi-code@${KIMI_REVIEWED_VERSION}`
  }
  if (action === "uninstall") return "npm uninstall --global @moonshot-ai/kimi-code"

  const command = agent.process?.command || "kimi"
  const home = agent.process?.env?.KIMI_CODE_HOME
  const configuredCwd = agent.process?.cwd
  const cwd = configuredCwd?.trim() ? configuredCwd : undefined
  if (command.includes("\0") || home?.includes("\0") || (home !== undefined && !home.trim())) {
    throw new Error("invalid Kimi command or state directory")
  }
  if (cwd && (!cwd.startsWith("/") || cwd.includes("\0"))) {
    throw new Error("an absolute POSIX working directory is required")
  }
  if (home !== undefined && !home.startsWith("/") && !cwd) {
    throw new Error("relative KIMI_CODE_HOME requires a working directory")
  }
  const parts = home === undefined ? [] : ["env", shellQuote(`KIMI_CODE_HOME=${home}`)]
  parts.push(shellQuote(command))
  switch (action) {
    case "native":
      break
    case "web":
      // Loopback and bearer authentication are native defaults. Never add
      // --host or --dangerous-bypass-auth to a management shortcut.
      parts.push("web")
      break
    case "export":
      if (!sessionId?.trim() || sessionId.startsWith("-") || sessionId.includes("\0")) {
        throw new Error("a native session identifier is required")
      }
      parts.push("export", shellQuote(sessionId), "--no-include-global-log")
      break
    default:
      parts.push(action)
  }
  const invocation = parts.join(" ")
  // A copied recipe must resolve relative state and session paths against the
  // same directory as the native host, regardless of the receiving terminal.
  return cwd ? `cd -- ${shellQuote(cwd)} && ${invocation}` : invocation
}
