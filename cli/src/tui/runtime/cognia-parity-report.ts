/**
 * Turn the session's live tool-host snapshot into the parity block `/status` and
 * `/doctor` print.
 *
 * Both panels used to describe an external backend from static assumptions. This
 * reads what the session actually achieved, so "plugins: supported" and "12
 * Cognia tools" are claims about this run rather than about the preset.
 */

import { readToolHostStatus, type ToolHostSnapshot } from "../../agent/tool-host/status"
import { fieldsByLayer } from "./context-lifecycle"
import type { CogniaParityReport } from "../state/types"

/** Build the block, or undefined when nothing was published for this session. */
export function buildCogniaParityReport(
  sessionId: string,
  read: (id: string) => ToolHostSnapshot | undefined = readToolHostStatus
): CogniaParityReport | undefined {
  const snapshot = read(sessionId)
  if (!snapshot) return undefined
  return {
    backend: snapshot.backend,
    contextVersion: snapshot.contextVersion,
    attachable: snapshot.attachable,
    running: snapshot.running,
    builtinToolCount: snapshot.builtinToolCount,
    hostToolCount: snapshot.hostToolCount,
    userMcpCount: snapshot.userMcpCount,
    connections: snapshot.connections,
    ...(snapshot.builtin ? { builtin: snapshot.builtin } : {}),
    restartRequired: fieldsByLayer("session"),
  }
}

/** One-line health summary for a compact surface. */
export function parityHealthLine(report: CogniaParityReport): string {
  if (report.builtin && report.builtin.phase !== "ready") {
    return `Cognia tools: ${report.builtin.phase} — ${report.builtin.reason ?? "Waiting for the tool host"}`
  }
  if (!report.attachable) return "Cognia tools: unavailable (this agent cannot host the bridge)"
  if (!report.running) return "Cognia tools: bridge not started"
  return `Cognia tools: ${report.builtinToolCount} built-in · ${report.hostToolCount} host · ${report.userMcpCount} user MCP`
}

/** Shared text for both diagnostic surfaces, including lazy service failures. */
export function builtinReadinessLines(report: CogniaParityReport): string[] {
  if (!report.builtin) return []
  const { phase, reason, runtime, categories } = report.builtin
  return [
    `Runtime: ${runtime ?? "unresolved"} · ${phase}${reason ? ` — ${reason}` : ""}`,
    ...Object.entries(categories).map(
      ([name, readiness]) =>
        `${name}: ${readiness.state}${readiness.reason ? ` — ${readiness.reason}` : ""}`
    ),
  ]
}
