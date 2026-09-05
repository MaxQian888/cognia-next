// Pure helpers for the renderer→sidecar live session-control round-trip.
//
// The renderer drives the Claude Agent SDK `Query`'s streaming-input-only
// control methods (getContextUsage / mcpServerStatus / setModel / …) by sending
// a `{ type: "control", sessionId, requestId, method, params }` line; the host
// looks up the session, invokes `q[method](...args)`, and replies with a
// `control_response` event. Keeping the allowlist + arg-mapping + response
// shaping here (no I/O) makes them unit-testable via `pnpm sidecar:test`.

/**
 * Allowlisted SDK `Query` control methods. Defense-in-depth: the host refuses
 * any method outside this set so a malformed/hostile `control` line can never
 * reflectively invoke an arbitrary property on the live query object.
 */
export const CONTROL_METHODS = new Set([
  "accountInfo",
  "applyFlagSettings",
  "backgroundTasks",
  "getContextUsage",
  "initializationResult",
  "mcpServerStatus",
  "readFile",
  "reconnectMcpServer",
  "reinitialize",
  "reloadPlugins",
  "reloadSkills",
  "rewindFiles",
  "seedReadState",
  "setMaxThinkingTokens",
  "setMcpPermissionModeOverride",
  "setMcpServers",
  "setModel",
  "setPermissionMode",
  "steer",
  "stopTask",
  "supportedAgents",
  "supportedCommands",
  "supportedModels",
  "toggleMcpServer",
])

/**
 * Capability each control method needs, mirroring
 * `protocol/agent-control-methods.json` (the gate proves the two agree).
 *
 * A session carrying a frozen execution spec is checked against its adapter's
 * table before the call is made, so an unservable control returns a typed
 * `capability_error` naming the capability instead of the generic
 * `unsupported_provider` you get from probing `q[method]`. Sessions without a
 * spec are never gated here — ADR-0090 constraint 6 keeps the legacy queue
 * byte-identical.
 */
export const CONTROL_METHOD_CAPABILITIES = {
  accountInfo: "session.manage",
  applyFlagSettings: "session.manage",
  backgroundTasks: "tasks.background",
  getContextUsage: "context-management",
  initializationResult: "session.manage",
  mcpServerStatus: "mcp",
  readFile: "checkpoint",
  reconnectMcpServer: "mcp",
  reinitialize: "session.manage",
  reloadPlugins: "plugins.native",
  reloadSkills: "skills.native",
  rewindFiles: "checkpoint",
  seedReadState: "checkpoint",
  setMaxThinkingTokens: "thinking",
  setMcpPermissionModeOverride: "mcp.dynamic",
  setMcpServers: "mcp.dynamic",
  setModel: "set-model",
  setPermissionMode: "permissions.set-mode",
  steer: "steer",
  stopTask: "tasks.background",
  supportedAgents: "subagents.manage",
  supportedCommands: "commands.dynamic",
  supportedModels: "set-model",
  toggleMcpServer: "mcp",
}

/** True when `method` is an allowlisted control method. */
export function isControlMethod(method) {
  return typeof method === "string" && CONTROL_METHODS.has(method)
}

/** The capability `method` needs, or undefined for an unknown method. */
export function controlMethodCapability(method) {
  return CONTROL_METHOD_CAPABILITIES[method]
}

/**
 * Map a control method + params object to the positional argument array for
 * `q[method](...args)`. No-arg methods return `[]`. Unknown methods are caught
 * earlier by {@link isControlMethod}.
 *
 * Optional trailing arguments are passed as `undefined` when absent rather than
 * being trimmed: the SDK's own defaults then apply, which is what a caller who
 * omitted the field asked for. Trimming would be indistinguishable for a
 * one-arg call but wrong for `setMaxThinkingTokens(n, display)`, where the
 * second parameter has three meanings (value / null / omitted).
 *
 * The `case` bodies here are read by `check:agent-control-methods` and compared
 * against the manifest's `args`, so the param NAMES are part of the contract.
 */
export function controlArgs(method, params) {
  const p = params ?? {}
  switch (method) {
    case "setPermissionMode":
      return [p.mode]
    case "setModel":
      return [p.model]
    case "reconnectMcpServer":
      return [p.serverName]
    case "toggleMcpServer":
      return [p.serverName, p.enabled]
    case "steer":
      return [p.prompt, p.priority]
    case "readFile":
      return [p.path, p.options]
    case "rewindFiles":
      return [p.userMessageId, p.options]
    case "seedReadState":
      return [p.path, p.mtime]
    case "setMaxThinkingTokens":
      return [p.maxThinkingTokens, p.thinkingDisplay]
    case "setMcpPermissionModeOverride":
      return [p.serverName, p.mode]
    case "setMcpServers":
      return [p.servers]
    case "stopTask":
      return [p.taskId]
    case "backgroundTasks":
      return [p.toolUseId]
    case "applyFlagSettings":
      return [p.settings]
    default:
      return []
  }
}

/** Transports `setMcpServers` will register. Anything else is refused. */
const MCP_TRANSPORTS = new Set(["stdio", "sse", "http", "sdk"])

/**
 * Reject a control frame whose params cannot be honoured, BEFORE it reaches the
 * live `Query`. Returns an error code string, or null when the frame is fine.
 *
 * `isControlMethod` already stops reflective access to arbitrary properties;
 * this is the second half — the arguments themselves. Three of these methods
 * mutate real state (`setMcpServers` connects servers, `seedReadState` tells
 * the CLI a file was already read, `rewindFiles` rewrites files on disk), so a
 * malformed frame reaching the SDK is a worse failure than a rejected one.
 *
 * The bar is deliberately structural, not semantic: whether a path is allowed
 * to be read, or a server allowed to run, stays the CLI's decision under its
 * own permission rules. This only refuses shapes that cannot mean anything.
 */
export function controlParamError(method, params) {
  const p = params ?? {}
  const str = (v) => typeof v === "string" && v.length > 0
  switch (method) {
    case "setPermissionMode":
      return ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"].includes(
        p.mode
      )
        ? null
        : "invalid_permission_mode"
    case "setModel":
      // `undefined` is meaningful here — the SDK reads it as "back to default".
      return p.model === undefined || str(p.model) ? null : "invalid_model"
    case "reconnectMcpServer":
      return str(p.serverName) ? null : "invalid_server_name"
    case "toggleMcpServer":
      if (!str(p.serverName)) return "invalid_server_name"
      return typeof p.enabled === "boolean" ? null : "invalid_enabled"
    case "readFile":
      return str(p.path) ? null : "invalid_path"
    case "rewindFiles":
      return str(p.userMessageId) ? null : "invalid_user_message_id"
    case "seedReadState":
      if (!str(p.path)) return "invalid_path"
      // A non-finite mtime would compare false against every real one, silently
      // turning the seed into a no-op instead of an error.
      return Number.isFinite(p.mtime) ? null : "invalid_mtime"
    case "setMaxThinkingTokens":
      if (p.maxThinkingTokens !== null && !Number.isFinite(p.maxThinkingTokens)) {
        return "invalid_max_thinking_tokens"
      }
      return p.thinkingDisplay === undefined ||
        p.thinkingDisplay === null ||
        p.thinkingDisplay === "summarized" ||
        p.thinkingDisplay === "omitted"
        ? null
        : "invalid_thinking_display"
    case "setMcpPermissionModeOverride":
      if (!str(p.serverName)) return "invalid_server_name"
      // Tighten-only by the SDK's own contract; anything else would be a
      // widening request the CLI will refuse anyway.
      return p.mode === null || p.mode === "default" || p.mode === "auto"
        ? null
        : "invalid_permission_mode"
    case "setMcpServers": {
      if (!p.servers || typeof p.servers !== "object" || Array.isArray(p.servers)) {
        return "invalid_servers"
      }
      for (const config of Object.values(p.servers)) {
        if (!config || typeof config !== "object") return "invalid_servers"
        // `type` is optional in the SDK's config union (stdio is the default),
        // so only an explicitly WRONG one is rejected.
        if (config.type !== undefined && !MCP_TRANSPORTS.has(config.type)) {
          return "unsupported_mcp_transport"
        }
      }
      return null
    }
    case "stopTask":
      return str(p.taskId) ? null : "invalid_task_id"
    case "backgroundTasks":
      // Absent means "background everything", which is the documented default.
      return p.toolUseId === undefined || str(p.toolUseId) ? null : "invalid_tool_use_id"
    case "applyFlagSettings":
      return p.settings && typeof p.settings === "object" && !Array.isArray(p.settings)
        ? null
        : "invalid_settings"
    default:
      return null
  }
}

/**
 * Shape the `control_response` event. On success `result` carries the SDK
 * return value (omitted when `undefined`); on failure `error` is a stable code
 * (`no_active_session` | `unsupported_provider` | `unknown_method`) or a thrown
 * message.
 */
export function buildControlResponse({ sessionId, requestId, method, ok, result, error }) {
  const msg = { type: "control_response", sessionId, requestId, method, ok }
  if (ok) {
    if (result !== undefined) msg.result = result
  } else {
    msg.error = error ?? "error"
  }
  return msg
}
