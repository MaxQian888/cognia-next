import type { AcpVendorProfile } from "../vendor-profile"

/** Permission authority is configured by MiniMaxAcpAdapter on its own process. */
export const minimaxAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "minimax-code",
  label: "MiniMax Code",
  commandNames: ["mcode"],
  permissionModes: {
    toNative: (mode) => {
      if (mode === "acceptEdits" || mode === "dontAsk")
        throw new Error(`MiniMax ACP cannot enforce ${mode}`)
      return mode === "plan" ? "plan" : "default"
    },
    toCanonical: (nativeMode, current) =>
      nativeMode === "plan" ? "plan" : current && current !== "plan" ? current : "default",
  },
  fork: {
    inheritsSourceWorkspace: true,
    requiresDistinctSessionId: true,
    rebindsMcpByReload: false,
  },
})
