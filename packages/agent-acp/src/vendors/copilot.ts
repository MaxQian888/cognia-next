import type { AcpVendorProfile } from "../vendor-profile"

const MODE = "https://agentclientprotocol.com/protocol/session-modes#"

/** Copilot's behavior mode and allow-all switch are independent of the host's tool policy. */
export const copilotAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "copilot-cli",
  label: "GitHub Copilot CLI",
  commandNames: ["copilot"],
  permissionModes: {
    // Autopilot also changes execution behavior. Even bypass stays in Agent mode;
    // Cognia's broker can grant requests without enabling native allow-all.
    toNative: (mode) => `${MODE}${mode === "plan" ? "plan" : "agent"}`,
    toCanonical: (nativeMode, current, options) => {
      if (
        nativeMode === `${MODE}autopilot` ||
        options?.some((option) => option.id === "allow_all" && option.currentValue === "on")
      )
        return "bypassPermissions"
      if (nativeMode === `${MODE}plan`) return "plan"
      return nativeMode === `${MODE}agent` && current && current !== "plan" ? current : "default"
    },
    requireAdvertised: { fallback: [`${MODE}agent`, `${MODE}plan`] },
    hostApprovalOption: { id: "allow_all", value: "off" },
  },
  terminalAuth: { methodId: "copilot-login", args: ["login"] },
  stdioMcpServersUnsupported:
    "GitHub Copilot CLI rejects stdio MCP servers supplied through ACP; use an HTTP or SSE MCP server instead",
})
