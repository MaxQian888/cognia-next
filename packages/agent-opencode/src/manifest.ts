/**
 * OpenCode integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads either adapter, the event mapper, the
 * launcher or the OpenCode SDKs.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

/**
 * The current OpenCode `/api` service. One service serves many sessions; a
 * session that needs Cognia's MCP projection or a gateway task gets its own
 * loopback service, which is why the per-session child is not the default
 * model. A cancel interrupts the session's turn and the service keeps running;
 * sessions are stored by the service, resume by id and fork natively, and
 * permission prompts arrive per tool call as forms.
 */
export const OPENCODE_V2_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "native",
  fork: "native",
  approvals: "per-tool-call",
  processModel: "shared",
}) as AgentExecutionSemantics

/**
 * The legacy OpenCode server API through `@opencode-ai/sdk` (`opencode
 * serve`, `./client`): a turn-scoped abort on a shared server, native resume
 * and fork, and per-call permissions. Cognia no longer registers this
 * protocol (it tells users to create a V2 configuration), so it is not in the
 * manifest's protocol list; the adapter stays for hosts that still speak it.
 */
export const OPENCODE_SERVER_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "native",
  fork: "native",
  approvals: "per-tool-call",
  processModel: "shared",
}) as AgentExecutionSemantics

export const OPENCODE_ECOSYSTEM_ID = "opencode"
export const OPENCODE_V2_PROTOCOL = "opencode-v2"
export const OPENCODE_SERVER_PROTOCOL = "opencode"
/** The session-history source id OpenCode sessions are imported under. */
export const OPENCODE_SESSION_SOURCE_ID = "opencode"

/**
 * OpenCode's runtime catalog rows. `pnpm gen:external-agent-runtimes` writes them
 * into `protocol/external-agent-runtimes.json`; edit them here, never there.
 */
export const OPENCODE_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = [
  {
    runtimeId: "opencode",
    presetIds: ["opencode-server"],
    displayName: "OpenCode (auto-spawn)",
    ownership: "system",
    protocol: "opencode",
    transport: "sse",
    platforms: ["darwin", "linux"],
    systemCommand: "opencode",
    launchArgs: [],
    versionProbe: {
      args: ["--version"],
      parser: "semver-anywhere",
      timeoutMs: 10000,
    },
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: false,
    },
    docsUrl: "https://opencode.ai/docs/server/",
  },
  {
    runtimeId: "opencode-acp",
    presetIds: ["opencode-acp"],
    displayName: "OpenCode (ACP)",
    ownership: "system",
    protocol: "acp",
    transport: "stdio",
    platforms: ["darwin", "linux"],
    systemCommand: "opencode",
    launchArgs: ["acp"],
    versionProbe: {
      args: ["--version"],
      parser: "semver-anywhere",
      timeoutMs: 10000,
    },
    supportedRange: ">=1.18.14",
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: false,
    },
    docsUrl: "https://opencode.ai/docs/acp/",
  },
  {
    runtimeId: "opencode-remote",
    presetIds: ["opencode-remote"],
    displayName: "OpenCode (remote server)",
    ownership: "remote",
    protocol: "opencode",
    transport: "sse",
    platforms: ["darwin", "linux", "win32"],
    distributions: [],
    sandbox: {
      required: false,
      windowsExceptionEligible: false,
    },
    docsUrl: "https://opencode.ai/docs/server/",
  },
  {
    runtimeId: "opencode-v2-service",
    presetIds: ["opencode-v2-service"],
    displayName: "OpenCode V2",
    ownership: "remote",
    protocol: "opencode-v2",
    transport: "sse",
    platforms: ["darwin", "linux", "win32"],
    distributions: [],
    sandbox: {
      required: false,
      windowsExceptionEligible: false,
    },
    docsUrl: "https://opencode.ai/v2/docs/build/client",
  },
]

export const opencodeManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: Object.freeze({
    id: OPENCODE_ECOSYSTEM_ID,
    runtimeIds: ["opencode-v2-service", "opencode-acp", "opencode", "opencode-remote"],
    sessionSourceIds: [OPENCODE_SESSION_SOURCE_ID],
    migrationVendor: "opencode",
    vendorRootKeys: ["opencodeDataDir", "opencodeConfigDir", "opencodePlatformDataDir"],
    // Config and history live apart. `configRootKey` feeds the subagent and
    // command scans, `probeRootKeys` feeds install detection, and the probe
    // order preserves the original `opencodeDataDir || opencodeConfigDir`.
    configRootKey: "opencodeConfigDir",
    probeRootKeys: ["opencodeDataDir", "opencodeConfigDir"],
    pluginEcosystem: null,
    subagentSourceId: "opencode",
    memoryAgentId: "opencode",
  }),
  // `opencode-acp` speaks plain ACP; its adapter belongs to the ACP integration.
  protocols: [{ protocol: OPENCODE_V2_PROTOCOL, semantics: OPENCODE_V2_EXECUTION_SEMANTICS }],
  runtimes: OPENCODE_RUNTIMES,
}) as AgentIntegrationManifest
