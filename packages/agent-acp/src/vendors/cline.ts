import type { AcpVendorProfile } from "../vendor-profile"

/**
 * Cline over ACP. Its only modes are `plan` and `act`; tool approval still
 * reaches the host, so every executable canonical mode maps to `act` and the
 * session keeps the one the user chose. It reads MCP servers from its own
 * configuration only.
 */
export const clineAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "cline",
  label: "Cline",
  commandNames: ["cline"],
  permissionModes: {
    toNative: (mode) => (mode === "plan" ? "plan" : "act"),
    toCanonical: (nativeMode, current) => {
      if (nativeMode === "plan") return "plan"
      return current && current !== "plan" ? current : "default"
    },
  },
  sessionMcpServersUnsupported:
    "Cline ACP does not forward session MCP servers; configure native servers with cline mcp",
  // Cline 3.0.67 advertises images but extracts only text from prompt blocks.
  // Fail visibly through the existing content validator instead of dropping images.
  promptCapabilityOverrides: { image: false },
})
