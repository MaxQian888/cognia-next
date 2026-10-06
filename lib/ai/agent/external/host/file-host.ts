/**
 * The app's implementation of the `AgentFileHost` port (ADR-0217).
 *
 * Integration packages reach workspace files only through
 * `@cognia/agent-contracts/host`. Every operation goes through the session
 * workspace file commands in `agent-transport`, which resolve the path against
 * the allowed roots and route to the selected Host; the Host refuses traversal
 * and symlink escapes. Containment uses the sandbox's own path semantics.
 */

import type { AgentFileHost } from "@cognia/agent-contracts/host"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import {
  agentDeleteTextFile,
  agentReadTextFile,
  agentWriteTextFile,
  supportsAgentFs,
} from "../agent-transport"

/** The file host every app-side integration gets. */
export function createAgentTransportFileHost(): AgentFileHost {
  return {
    get available() {
      return supportsAgentFs()
    },
    isWithinRoot: (path, root) => isPathUnderRoot(path, root),
    readText: (path, allowedRoots) => agentReadTextFile(path, [...allowedRoots]),
    writeText: (path, content, allowedRoots) =>
      agentWriteTextFile(path, content, [...allowedRoots]),
    delete: (path, allowedRoots) => agentDeleteTextFile(path, [...allowedRoots]),
  }
}
