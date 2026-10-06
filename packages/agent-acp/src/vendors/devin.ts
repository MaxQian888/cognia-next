import type { AcpPermissionMode } from "@cognia/agent-contracts/external-agent"
import type { AcpVendorProfile } from "../vendor-profile"

const DEVIN_PERMISSION_MODES: Record<AcpPermissionMode, string> = {
  default: "ask",
  acceptEdits: "accept-edits",
  bypassPermissions: "bypass",
  plan: "plan",
  dontAsk: "ask",
}

/**
 * Devin over ACP. `dontAsk` shares the wire value `ask` with `default`, and
 * Devin supplies its programmatic tool identity in vendor metadata rather than
 * the human-readable title; recovering it restores namespace recognition by
 * the host's permission callback and grants nothing.
 */
export const devinAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "devin",
  label: "Devin",
  commandNames: ["devin"],
  permissionModes: {
    toNative: (mode) => DEVIN_PERMISSION_MODES[mode] ?? mode,
    toCanonical: (nativeMode, current) => {
      if (nativeMode === "accept-edits") return "acceptEdits"
      if (nativeMode === "bypass") return "bypassPermissions"
      if (nativeMode === "plan") return "plan"
      if (nativeMode === "ask" && current === "dontAsk") return "dontAsk"
      return "default"
    },
  },
  toolIdentity: (meta) => {
    const name = [meta?.["cognition.ai/inferenceToolName"], meta?.["cognition.ai/toolName"]].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    )
    return name ? { name } : undefined
  },
})
