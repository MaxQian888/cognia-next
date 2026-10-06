import type { AcpPermissionMode } from "@cognia/agent-contracts/external-agent"
import type { AcpVendorProfile } from "../vendor-profile"

// Keep edit-only and deny-unapproved policies in Cognia's permission broker.
// Goose's smart_approve would make its own approval decisions before the client.
const GOOSE_PERMISSION_MODES: Record<AcpPermissionMode, string> = {
  default: "approve",
  acceptEdits: "approve",
  bypassPermissions: "auto",
  plan: "chat",
  dontAsk: "approve",
}

/**
 * Goose over ACP. A saved Goose config may default to `auto`, so the process
 * starts with approval enabled and the session mode is applied afterwards.
 * Goose keeps the programmatic tool name in its initial tool-call metadata;
 * permission updates carry only a generated human title.
 */
export const gooseAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "goose",
  label: "Goose",
  commandNames: ["goose"],
  permissionModes: {
    toNative: (mode) => GOOSE_PERMISSION_MODES[mode] ?? mode,
    toCanonical: (nativeMode, current) => {
      if (nativeMode === "chat") return "plan"
      if (nativeMode === "auto") return "bypassPermissions"
      if (current && GOOSE_PERMISSION_MODES[current] === nativeMode) return current
      return "default"
    },
  },
  launchEnv: { GOOSE_MODE: "approve" },
  toolIdentity: (meta) => {
    const raw = (meta?.goose as { toolCall?: { toolName?: unknown } } | undefined)?.toolCall
      ?.toolName
    if (typeof raw !== "string" || !raw.trim()) return undefined
    const name = /^(cognia-tools|cognia-plugin-tools)__.+/.test(raw) ? `mcp__${raw}` : raw
    // Goose reports these platform file operations as "other". Classify only
    // known identities so acceptEdits can apply the existing file policy.
    const kind = name === "read" ? "read" : name === "write" || name === "edit" ? "edit" : undefined
    return { name, kind }
  },
  preApprovalMatchesToolName: true,
})
