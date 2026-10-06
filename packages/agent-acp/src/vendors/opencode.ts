import type { AcpPermissionMode } from "@cognia/agent-contracts/external-agent"
import type { AcpVendorProfile } from "../vendor-profile"

/**
 * OpenCode's ACP surface exposes its agent selector through the session `mode`
 * config option, whose only values are "build" and "plan". Tool approval still
 * flows through `session/request_permission`, so every non-plan canonical mode
 * maps to "build" and the local permission broker keeps the requested policy.
 */
const OPENCODE_PERMISSION_MODES: Record<AcpPermissionMode, string> = {
  default: "build",
  acceptEdits: "build",
  bypassPermissions: "build",
  plan: "plan",
  dontAsk: "build",
}

/** OpenCode over ACP (the `opencode-acp` preset). */
export const openCodeAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "opencode-acp",
  label: "OpenCode",
  commandNames: ["opencode"],
  permissionModes: {
    toNative: (mode) => OPENCODE_PERMISSION_MODES[mode] ?? mode,
    toCanonical: (nativeMode, current) => {
      if (nativeMode === "plan") return "plan"
      // "build" is the wire value for every executable canonical mode. Keep the
      // session's current mode when it already maps there so a server echo does
      // not collapse acceptEdits / bypassPermissions / dontAsk into "default".
      if (current && OPENCODE_PERMISSION_MODES[current] === nativeMode) return current
      return "default"
    },
  },
})
