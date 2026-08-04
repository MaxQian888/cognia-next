/**
 * JSON-lines protocol between the CLI and the Node sidecar
 * (`sidecar/claude-host.mjs`).
 *
 * This mirrors the wire contract the desktop's Rust layer
 * (`src-tauri/src/claude/{commands,sidecar}.rs`) implements. The
 * {@link StdioTransport} is a faithful Node port of that bridge, MINUS the
 * settings.json hook interception (a desktop-only feature) — the CLI handles
 * permission decisions through `runAndCaptureAssistantReply`'s
 * `onPermissionRequest` callback instead.
 *
 * Keeping the shapes here (rather than reaching into the sidecar's `.mjs`)
 * gives the transport + its tests a typed, drift-checkable contract.
 */

/** Tauri event channel the renderer subscribes to; reused verbatim by the CLI. */
export const SIDECAR_EVENT = "claude://message"
/** Canonical AgentEventEnvelope channel, matching the desktop Rust bridge. */
export const AGENT_EVENT = "agent://message"
/** Dedicated A2UI dispatch channel (desktop parity; unused by CLI v1). */
export const A2UI_EVENT = "a2ui://dispatch"

/** Inbound message types written to the sidecar's stdin. */
export type InboundMessage =
  | { type: "send"; sessionId: string; prompt: unknown; options?: unknown }
  | { type: "interrupt"; sessionId: string }
  | { type: "compact"; sessionId: string; focus?: string }
  | { type: "set_mode"; sessionId: string; mode: string }
  | {
      type: "permission_response"
      sessionId: string
      requestId: string
      decision: "allow" | "allow_always" | "deny"
      message?: string
      updatedInput?: unknown
    }
  | {
      type: "plugin_tool_response"
      sessionId: string
      toolUseId: string
      result?: unknown
      error?: string
    }
  | {
      type: "tool_result_decision"
      sessionId: string
      reviewId: string
      updatedToolOutput?: unknown
    }
  | {
      // Live SDK `Query` control round-trip (getContextUsage / mcpServerStatus /
      // setModel / …). The sidecar replies with a correlated `control_response`.
      type: "control"
      sessionId: string
      requestId: string
      method: string
      params?: unknown
    }
  | {
      type: "session_api"
      requestId: string
      method: string
      params?: unknown
      sendOptions?: unknown
    }
  | { type: "close"; sessionId: string }

/**
 * Outbound messages the sidecar writes to stdout, one JSON object per line.
 * Only `type` is guaranteed; the rest is forwarded verbatim to subscribers,
 * which narrow by `type` themselves (matching how the desktop emits the raw
 * value on the `claude://message` channel).
 */
export interface OutboundMessage {
  type:
    | "event"
    | "permission_request"
    | "tool_result_review"
    | "plugin_tool_exec"
    | "protocol_adapter_exec"
    | "session_ended"
    | "ready"
    | "log"
    | "mcp_log"
    | "a2ui_dispatch"
    | "usage_headers"
    | "control_response"
    | "sidecar_exited"
    | (string & {})
  sessionId?: string
  [key: string]: unknown
}

/** Tauri command names the agent loop issues, mapped to inbound messages. */
export const COMMAND = {
  SEND: "claude_send",
  INTERRUPT: "claude_interrupt",
  COMPACT: "claude_compact",
  SET_MODE: "claude_set_mode",
  APPROVE: "claude_approve",
  CLOSE: "claude_close_session",
  TOOL_RESULT_DECISION: "claude_tool_result_decision",
  PLUGIN_TOOL_RESPONSE: "claude_plugin_tool_response",
  SESSION_CONTROL: "claude_session_control",
  SESSION_API: "agent_session_api",
  SIDECAR_STATUS: "claude_sidecar_status",
} as const

/**
 * Translate a `transport.call(name, args)` into the sidecar stdin message, or
 * return `null` for status (a local read, no write). Throws for unsupported
 * commands so a wiring mistake surfaces loudly instead of silently no-op'ing.
 *
 * Pure + exported so the mapping is unit-testable without a live sidecar.
 */
export function commandToInbound(
  name: string,
  args: Record<string, unknown> = {}
): InboundMessage | null {
  switch (name) {
    case COMMAND.SEND: {
      const msg: InboundMessage = {
        type: "send",
        sessionId: String(args.sessionId),
        prompt: args.prompt,
      }
      if (args.options !== undefined) msg.options = args.options
      return msg
    }
    case COMMAND.INTERRUPT:
      return { type: "interrupt", sessionId: String(args.sessionId) }
    case COMMAND.COMPACT: {
      const msg: InboundMessage = { type: "compact", sessionId: String(args.sessionId) }
      const focus = args.focus
      if (typeof focus === "string" && focus.trim().length > 0) msg.focus = focus.trim()
      return msg
    }
    case COMMAND.SET_MODE: {
      const mode = String(args.mode)
      if (
        mode !== "default" &&
        mode !== "plan" &&
        mode !== "acceptEdits" &&
        mode !== "bypassPermissions"
      ) {
        throw new Error(`invalid permission mode: ${mode}`)
      }
      return { type: "set_mode", sessionId: String(args.sessionId), mode }
    }
    case COMMAND.APPROVE: {
      const decision = String(args.decision)
      if (decision !== "allow" && decision !== "allow_always" && decision !== "deny") {
        throw new Error(`invalid approval decision: ${decision}`)
      }
      return {
        type: "permission_response",
        sessionId: String(args.sessionId),
        requestId: String(args.requestId),
        decision,
        message: args.message as string | undefined,
        updatedInput: args.updatedInput,
      }
    }
    case COMMAND.CLOSE:
      return { type: "close", sessionId: String(args.sessionId) }
    case COMMAND.TOOL_RESULT_DECISION:
      return {
        type: "tool_result_decision",
        sessionId: String(args.sessionId),
        reviewId: String(args.reviewId),
        updatedToolOutput: args.updatedToolOutput,
      }
    case COMMAND.PLUGIN_TOOL_RESPONSE:
      return {
        type: "plugin_tool_response",
        sessionId: String(args.sessionId),
        toolUseId: String(args.toolUseId),
        result: args.result,
        error: args.error as string | undefined,
      }
    case COMMAND.SESSION_CONTROL:
      return {
        type: "control",
        sessionId: String(args.sessionId),
        requestId: String(args.requestId),
        method: String(args.method),
        params: args.params,
      }
    case COMMAND.SESSION_API:
      return {
        type: "session_api",
        requestId: String(args.requestId),
        method: String(args.method),
        params: args.params,
        sendOptions: args.sendOptions,
      }
    case COMMAND.SIDECAR_STATUS:
      return null // local read — handled by the transport, no stdin write
    default:
      throw new Error(`StdioTransport: unsupported command "${name}"`)
  }
}
