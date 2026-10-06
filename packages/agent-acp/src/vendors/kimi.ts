import type { AcpVendorProfile } from "../vendor-profile"

/**
 * Kimi Code over ACP. Its native `auto` also skips shell approvals, so every
 * executable mode except `bypassPermissions` maps to `default` and the host's
 * broker keeps edit-only and deny-unapproved policies. A fork stays in the
 * source workspace and ignores MCP servers, which are bound by reload.
 */
export const kimiAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "kimi",
  label: "Kimi",
  commandNames: ["kimi"],
  permissionModes: {
    toNative: (mode) =>
      mode === "plan" ? "plan" : mode === "bypassPermissions" ? "yolo" : "default",
    toCanonical: (nativeMode, current) => {
      if (nativeMode === "plan") return "plan"
      if (nativeMode === "yolo") return "bypassPermissions"
      if (
        nativeMode === "default" &&
        current &&
        kimiAcpProfile.permissionModes!.toNative(current) === nativeMode
      )
        return current
      return "default"
    },
  },
  // Kimi ACP acknowledges background begin(), without a terminal result.
  // /tasks uses a separate task service and cannot confirm compaction.
  compactionCompletionUnavailable: {
    reason: "kimi_acp_compaction_completion_unavailable",
    message:
      "Kimi ACP compaction completion capability is unavailable; native /compact only starts background work",
  },
  fork: {
    inheritsSourceWorkspace: true,
    requiresDistinctSessionId: true,
    rebindsMcpByReload: true,
  },
})
