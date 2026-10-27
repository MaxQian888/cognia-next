/**
 * ACP-specific deviations for the 2026-10-27 catalog expansion. The common
 * transport owns execution; these profiles constrain vendor authority and
 * never manufacture negotiated optional capabilities (ADR-0217).
 */
import type { AcpPermissionMode } from "@cognia/agent-contracts/external-agent"
import type { AcpVendorProfile } from "../vendor-profile"

function brokerModes(
  execute: string,
  plan = "plan",
  supported: readonly AcpPermissionMode[] = ["default", "bypassPermissions"]
): NonNullable<AcpVendorProfile["permissionModes"]> {
  return {
    supportedCanonicalModes: supported,
    toNative: (mode) => {
      if (!supported.includes(mode))
        throw new Error(
          `This ACP runtime cannot enforce ${mode} against native pre-approved tools; use default or bypassPermissions`
        )
      return mode === "plan" ? plan : execute
    },
    toCanonical: (native, current) =>
      native === plan && plan !== execute && supported.includes("plan")
        ? "plan"
        : native === execute
          ? current && supported.includes(current)
            ? current
            : "default"
          : "bypassPermissions",
    requireAdvertised: { fallback: [execute] },
  }
}

function rejectUnmediatedMandatoryApprovals(
  label: string
): NonNullable<AcpVendorProfile["validateConfiguration"]> {
  return (config) => {
    if (config.requireApprovalFor?.length)
      throw new Error(
        `${label} can execute native pre-approved tools without an ACP permission request; mandatory host approval rules cannot be enforced`
      )
  }
}

export const auggieAcpProfile: AcpVendorProfile = Object.freeze({
  id: "auggie",
  label: "Auggie",
  commandNames: ["auggie"],
  permissionModes: brokerModes("default", "default"),
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Auggie"),
  launchEnv: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
})
export const autohandCodeAcpProfile: AcpVendorProfile = Object.freeze({
  id: "autohand-code",
  label: "Autohand Code",
  commandNames: ["autohand"],
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Autohand Code"),
  permissionModes: brokerModes("default"),
  reapplySessionMode: true,
  terminalAuth: { methodId: "autohand-setup", args: ["--setup"] },
})
export const codebuddyAcpProfile: AcpVendorProfile = Object.freeze({
  id: "codebuddy",
  label: "CodeBuddy",
  commandNames: ["codebuddy"],
  validateConfiguration: rejectUnmediatedMandatoryApprovals("CodeBuddy"),
  // Upstream plan inherits the preceding native policy. Cognia's plan broker
  // therefore runs against default rather than inheriting a native bypass.
  permissionModes: brokerModes("default", "default"),
  reapplySessionMode: true,
  // Upstream explicitly treats this flag as a permission bypass.
  launchEnv: { CODEBUDDY_IS_SANDBOX: "", CODEBUDDY_SUBAGENT_PERMISSION_MODE: "ignore" },
})
export const commandCodeAcpProfile: AcpVendorProfile = Object.freeze({
  id: "command-code",
  label: "Command Code",
  commandNames: ["cmdc", "commandcode", "command-code"],
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Command Code"),
  permissionModes: brokerModes("default"),
  reapplySessionMode: true,
  sseMcpServersUnsupported:
    "Command Code does not accept legacy SSE MCP servers; use streamable HTTP",
})
export const kilocodeAcpProfile: AcpVendorProfile = Object.freeze({
  id: "kilocode",
  label: "Kilo Code",
  commandNames: ["kilo"],
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Kilo Code"),
  permissionModes: brokerModes("build"),
  reapplySessionMode: true,
})
export const mistralVibeAcpProfile: AcpVendorProfile = Object.freeze({
  id: "mistral-vibe",
  label: "Mistral Vibe",
  commandNames: ["vibe-acp"],
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Mistral Vibe"),
  // v3 modes are agent names, and no native plan agent is advertised.
  permissionModes: brokerModes("ask", "ask"),
  reapplySessionMode: true,
})
export const mimoCodeAcpProfile: AcpVendorProfile = Object.freeze({
  id: "mimo-code",
  label: "MiMo Code",
  commandNames: ["mimo"],
  validateConfiguration: rejectUnmediatedMandatoryApprovals("MiMo Code"),
  permissionModes: brokerModes("build"),
  reapplySessionMode: true,
  terminalAuth: { methodId: "opencode-login", command: "mimo", args: ["auth", "login"] },
  launchEnv: { MIMOCODE_ENABLE_QUESTION_TOOL: "0" },
})
export const hermesAgentAcpProfile: AcpVendorProfile = Object.freeze({
  id: "hermes-agent",
  label: "Hermes Agent",
  commandNames: ["hermes", "hermes-acp"],
  permissionModes: brokerModes("default", "default"),
  reapplySessionMode: true,
  validateConfiguration: (
    config: import("@cognia/agent-contracts/external-agent").ExternalAgentConfig
  ) => {
    rejectUnmediatedMandatoryApprovals("Hermes Agent")(config)
    if (config.stateIsolation !== "isolated")
      throw new Error(
        "Hermes requires isolated native state; configure provider credentials with native setup in its Cognia-owned HERMES_HOME"
      )
  },
  requiresControlledDaemon: true,
  launchEnv: { HERMES_TUI_GATEWAY_URL: "" },
  // A transport exit only detaches the ACP viewer from Hermes' gateway.
  cancelAcknowledgementTimeoutMs: 10000,
})
export const ohMyPiAcpProfile: AcpVendorProfile = Object.freeze({
  id: "oh-my-pi",
  label: "oh-my-pi",
  commandNames: ["omp"],
  validateConfiguration: rejectUnmediatedMandatoryApprovals("oh-my-pi"),
  permissionModes: brokerModes("default"),
  reapplySessionMode: true,
  requiresGuardedClientPorts: true,
})
export const museAcpProfile: AcpVendorProfile = Object.freeze({
  id: "muse",
  label: "Muse Code",
  commandNames: ["muse-acp"],
  permissionModes: brokerModes("default", "default"),
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Muse Code"),
  terminalAuth: { methodId: "muse-login", command: "muse", args: ["login"] },
  requiresSessionMcpHttpGrant: true,
  launchEnv: {
    MUSE_APPROVAL_MODE: "promptUnmatched",
    MUSE_EDITOR_TOOLS: "1",
    MUSE_ALLOW_UNSCOPED_READS: "0",
  },
  sseMcpServersUnsupported: "Muse Code does not accept SSE MCP servers; use stdio or HTTP",
})
export const ampAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "amp",
  label: "Amp",
  commandNames: ["amp-acp"],
  launchEnv: { AMP_ACP_CONTINUE_LATEST: "0", AMP_ACP_TRANSPORT: "cli" },
  validateConfiguration: (config) => {
    if (config.requireApprovalFor?.length)
      throw new Error("Amp ACP cannot enforce mandatory host approval rules")
  },
  validateConfigOption: (id, value) => {
    if (id === "execution-environment" && value !== "local")
      throw new Error("Amp Orb execution cannot enforce this host's permissions or MCP policy")
    if (id === "permission" && value !== "default")
      throw new Error("Amp's native bypass switch is not a Cognia permission mode")
  },
  permissionModes: {
    supportedCanonicalModes: ["bypassPermissions"],
    toNative: (mode: AcpPermissionMode) => {
      if (mode !== "bypassPermissions")
        throw new Error(
          `Amp ACP cannot enforce ${mode}; explicit unrestricted local execution is required`
        )
      return "default"
    },
    toCanonical: () => "bypassPermissions",
    hostApprovalOption: { id: "permission", value: "default" },
  },
  reapplySessionMode: true,
  semantics: {
    cancel: { scope: "turn", reconnectsAfterCancel: false },
    resume: "native",
    fork: "unsupported",
    approvals: "none",
    processModel: "shared",
  },
})
export const zcodeAcpProfile: AcpVendorProfile = Object.freeze({
  id: "zcode",
  label: "ZCode",
  commandNames: ["zcode-acp"],
  permissionModes: brokerModes("default", "plan", [
    "default",
    "acceptEdits",
    "dontAsk",
    "bypassPermissions",
    "plan",
  ]),
  reapplySessionMode: true,
  terminalAuth: { methodId: "zcode-login", args: ["--login"] },
  promptCapabilityOverrides: { image: false },
  // The standard stdio path owns approval replies; file and one-shot bridges do not.
  launchEnv: { ZCODE_ACP_APPROVAL_BRIDGE: "0", ZCODE_ACP_APPROVAL_DIR: "" },
})

export const CATALOG_EXPANSION_ACP_PROFILES = Object.freeze([
  auggieAcpProfile,
  autohandCodeAcpProfile,
  codebuddyAcpProfile,
  commandCodeAcpProfile,
  kilocodeAcpProfile,
  mistralVibeAcpProfile,
  mimoCodeAcpProfile,
  hermesAgentAcpProfile,
  ohMyPiAcpProfile,
  museAcpProfile,
  ampAcpProfile,
  zcodeAcpProfile,
])
