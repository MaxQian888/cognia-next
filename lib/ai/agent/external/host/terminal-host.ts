/**
 * The app's implementation of the `AgentTerminalHost` port (ADR-0217).
 *
 * ACP `terminal/*` requests and terminal authentication run in host-owned
 * terminals (`acp_terminal_*` commands), which only a desktop shell without a
 * remote Host selected can offer. In the CLI the native module is the Node
 * shim, which answers the same commands.
 */

import type { AgentTerminalHost } from "@cognia/agent-contracts/host"
import {
  acpTerminalCreate,
  acpTerminalKill,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalWaitForExit,
  acpTerminalWrite,
  cleanupSessionTerminals,
} from "@/lib/native/external-agent"
import { supportsAgentTerminal } from "../agent-transport"

/** The terminal host every app-side integration gets. */
export function createNativeTerminalHost(): AgentTerminalHost {
  return {
    get available() {
      return supportsAgentTerminal()
    },
    create: (request) =>
      acpTerminalCreate(
        request.sessionId,
        request.command,
        request.args ?? [],
        request.cwd,
        request.env,
        request.outputByteLimit
      ),
    output: (terminalId, outputByteLimit) => acpTerminalOutput(terminalId, outputByteLimit),
    write: (terminalId, data) => acpTerminalWrite(terminalId, data),
    kill: (terminalId) => acpTerminalKill(terminalId),
    release: (terminalId) => acpTerminalRelease(terminalId),
    waitForExit: (terminalId, timeoutMs) => acpTerminalWaitForExit(terminalId, timeoutMs),
    closeSession: (sessionId) => cleanupSessionTerminals(sessionId),
  }
}
