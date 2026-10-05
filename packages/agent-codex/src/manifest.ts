/**
 * Codex integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the app-server adapter, the history
 * parser or any process code.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

/**
 * `turn/interrupt` stops one turn by id; the thread and the shared app-server
 * process keep running. Resume is native (`thread/resume`); a fork is native
 * but only at a completed turn boundary (typed forks need Codex ≥ 0.159.2).
 * Command, file and permission approvals arrive one call at a time.
 */
export const CODEX_APP_SERVER_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "native",
  fork: "native-turn-boundary",
  approvals: "per-tool-call",
  processModel: "shared",
}) as AgentExecutionSemantics

export const CODEX_ECOSYSTEM_ID = "codex"
export const CODEX_APP_SERVER_PROTOCOL = "codex-app-server"
/** The session-history source id Codex rollouts are imported under. */
export const CODEX_SESSION_SOURCE_ID = "codex"

export const codexManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: Object.freeze({
    id: CODEX_ECOSYSTEM_ID,
    // ACP first: `VENDOR_RUNTIME` resolved codex to the `codex` preset, which
    // the ACP adapter owns. Listing the app-server first would silently change
    // which connection the post-migration offer creates.
    runtimeIds: ["codex-acp", "codex-app-server"],
    sessionSourceIds: [CODEX_SESSION_SOURCE_ID],
    migrationVendor: "codex",
    vendorRootKeys: ["codexHome"],
    configRootKey: "codexHome",
    probeRootKeys: ["codexHome"],
    pluginEcosystem: "codex",
    subagentSourceId: "codex-cli",
    memoryAgentId: "codex",
  }),
  // The `codex-acp` runtime speaks plain ACP; its adapter belongs to the ACP
  // integration. This package ships the app-server adapter.
  protocols: [
    { protocol: CODEX_APP_SERVER_PROTOCOL, semantics: CODEX_APP_SERVER_EXECUTION_SEMANTICS },
  ],
}) as AgentIntegrationManifest
