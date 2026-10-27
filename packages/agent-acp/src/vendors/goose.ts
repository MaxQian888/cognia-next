import type { AcpPermissionMode } from "@cognia/agent-contracts/external-agent"
import type { AcpVendorProfile } from "../vendor-profile"

let noticeSequence = 0

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

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
  // Saved sessions retain their native mode; launch env alone cannot restore approvals.
  reapplySessionMode: true,
  clientCapabilitiesMeta: { goose: { customNotifications: true } },
  toolMetadata: (meta, parentSessionId) => {
    const id = object(meta?.goose)?.subagentSessionId
    if (
      typeof id !== "string" ||
      !id.trim() ||
      id.length > 256 ||
      Array.from(id).some((char) => char.charCodeAt(0) < 32)
    )
      return undefined
    return { nativeSubagent: { runtime: "goose", parentSessionId, sessionId: id, readOnly: true } }
  },
  notification: (method, params, timestamp) => {
    if (method !== "_goose/unstable/session/update" || typeof params.sessionId !== "string")
      return null
    const update = object(params.update)
    const status = object(update?.status)
    if (
      update?.sessionUpdate === "status_message" &&
      (status?.type === "notice" || status?.type === "progress") &&
      typeof status.message === "string" &&
      status.message.length <= 65536
    ) {
      return status.type === "progress"
        ? { type: "commentary_delta", sessionId: params.sessionId, timestamp, text: status.message }
        : {
            type: "extension_ui_update",
            sessionId: params.sessionId,
            timestamp,
            id: `goose-notice-${++noticeSequence}`,
            update: {
              kind: "notification",
              level: "info",
              message: status.message,
            },
          }
    }
    if (
      update?.sessionUpdate === "usage_update" &&
      typeof update.used === "number" &&
      Number.isFinite(update.used) &&
      update.used >= 0 &&
      typeof update.contextLimit === "number" &&
      Number.isFinite(update.contextLimit) &&
      update.contextLimit > 0
    ) {
      const cost =
        typeof update.accumulatedCost === "number" &&
        Number.isFinite(update.accumulatedCost) &&
        update.accumulatedCost >= 0
          ? { amount: update.accumulatedCost, currency: "USD" }
          : undefined
      return {
        type: "usage_update",
        sessionId: params.sessionId,
        timestamp,
        used: update.used,
        size: update.contextLimit,
        ...(cost ? { cost } : {}),
      }
    }
    return null
  },
  permissionModes: {
    mandatoryApprovalMode: "approve",
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
