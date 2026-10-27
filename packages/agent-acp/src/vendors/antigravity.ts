import type { AcpPermissionMode } from "@cognia/agent-contracts/external-agent"
import type { AcpVendorProfile } from "../vendor-profile"

// Official ACP 1.4.3 uses these ids in config_options.py. Native session restore
// retains auto_edit/yolo, so setup must restore the caller's host policy first.
const NATIVE_MODES: Partial<Record<AcpPermissionMode, string>> = {
  default: "default",
  acceptEdits: "auto_edit",
  bypassPermissions: "yolo",
  dontAsk: "default",
}

export const antigravityAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "antigravity-acp",
  label: "Antigravity",
  commandNames: ["agy_acp_server.par", "agy_acp_server"],
  systemPromptNamespace: "antigravity",
  reapplySessionMode: true,
  permissionModes: {
    mandatoryApprovalMode: "default",
    toNative(mode) {
      const native = NATIVE_MODES[mode]
      if (!native) throw new Error("Antigravity ACP does not support Plan mode")
      return native
    },
    toCanonical(nativeMode, current) {
      if (nativeMode === "auto_edit") return "acceptEdits"
      if (nativeMode === "yolo") return "bypassPermissions"
      if (nativeMode === "default") return current === "dontAsk" ? "dontAsk" : "default"
      throw new Error(`Antigravity ACP reported an unknown permission mode: ${nativeMode}`)
    },
    requireAdvertised: { fallback: ["default"] },
  },
})
