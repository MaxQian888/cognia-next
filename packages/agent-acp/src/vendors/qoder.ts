import type { AcpVendorProfile } from "../vendor-profile"

/**
 * Qoder over ACP: snake_case mode ids, and a mode the session does not
 * advertise is refused rather than sent.
 */
export const qoderAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "qoder",
  label: "Qoder",
  commandNames: ["qoder"],
  permissionModes: {
    toNative: (mode) =>
      mode === "acceptEdits"
        ? "accept_edits"
        : mode === "bypassPermissions"
          ? "bypass_permissions"
          : mode === "dontAsk"
            ? "dont_ask"
            : mode,
    toCanonical: (nativeMode) => {
      if (nativeMode === "accept_edits") return "acceptEdits"
      if (nativeMode === "bypass_permissions") return "bypassPermissions"
      if (nativeMode === "dont_ask") return "dontAsk"
      if (nativeMode === "plan") return "plan"
      return "default"
    },
    requireAdvertised: { fallback: ["default", "bypass_permissions"] },
  },
})
