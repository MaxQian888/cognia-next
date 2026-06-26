// Anthropic dispatch: thin wrapper around `@anthropic-ai/claude-agent-sdk`'s
// `query()` plus the in-process MCP servers (cognia-tools + a2ui-bridge).
//
// Returns the `Session` shape consumed by `claude-host.mjs`:
//   { q, pushUserMessage, closeInput, pendingApprovals }
//
// Behaviour parity: this module is a straight extraction of what the
// pre-port `startSession` did when no provider field was set. The protocol
// emitted on stdout is unchanged (sdk_session_id / event / permission_request
// / session_ended).

import { query } from "@anthropic-ai/claude-agent-sdk"
import { randomUUID } from "node:crypto"
import {
  buildCogniaToolsServer,
  namesForDisabledCategories,
  SERVER_NAME as BUILTIN_SERVER_NAME,
} from "../builtin-tools/index.mjs"
import { buildA2UIBridgeServer, SERVER_NAME as A2UI_SERVER_NAME } from "../a2ui-tools/index.mjs"
import {
  buildPluginToolsServer,
  SERVER_NAME as PLUGIN_TOOLS_SERVER_NAME,
} from "../builtin-tools/plugin-tools.mjs"
import { makeInputStream } from "./input-stream.mjs"
import { extractHttpErrorMeta } from "./http-error-meta.mjs"
import { foldSystemPrompt, thinkingFromBudget } from "./system-prompt.mjs"
import { resolveForToolCall } from "./permission-resolver.mjs"
import {
  makeServerAlwaysLoad,
  alwaysLoadToolSet,
  stampUserServersAlwaysLoad,
} from "./tool-search-policy.mjs"
import { buildLspHooks } from "./lsp-hooks.mjs"
import { makeLazyLspResolver } from "./lsp-resolver-factory.mjs"
import { createDoomLoopGuard } from "./doom-loop.mjs"
import { createReadTracker } from "../builtin-tools/core/read-tracker.mjs"
import { createBgShellRegistry } from "../builtin-tools/core/bash-sessions.mjs"

/** Bare name of the `ask_user` elicitation tool (namespaced by the sidecar as
 * `mcp__cognia-plugin-tools__ask_user`). */
const ASK_USER_TOOL_NAME = "ask_user"

/**
 * True when a (possibly namespaced) tool name refers to the `ask_user`
 * elicitation tool. `ask_user` IS the user interaction — the renderer's
 * AskUserDialog blocks until the user answers — so it must never be routed
 * through the generic tool-approval modal in any permission mode.
 */
function isAskUserTool(toolName) {
  const parts = String(toolName).split("__")
  const bare = parts.length >= 3 ? parts.slice(2).join("__") : String(toolName)
  return bare === ASK_USER_TOOL_NAME
}

/**
 * Settle every pending tool/approval round-trip immediately so a renderer that
 * never answers (crashed, navigated away, or the host is tearing the session
 * down) can't wedge the in-flight turn.
 *
 * The Anthropic `Query.interrupt()` aborts the SDK's own turn and the per-tool
 * `ctx.signal` settles `pendingApprovals`, but `pendingPluginToolCalls` have NO
 * abort/signal wiring — without this they only clear on the plugin-tool per-call
 * timeout. This is the explicit, immediate drain (symmetric with the ai-sdk
 * path, whose `q.interrupt()` drains its pending maps inline). Pure + exported
 * so the drain semantics are unit-testable without spawning the agent SDK.
 *
 * @param {{
 *   pendingApprovals?: Map<string, { resolve: (r: any) => void }>,
 *   pendingPluginToolCalls?: Map<string, { resolve: (r: any) => void }>,
 * }} maps
 * @param {string} [reason]
 */
export function drainPendingRoundTrips(
  { pendingApprovals, pendingPluginToolCalls } = {},
  reason = "interrupted"
) {
  if (pendingApprovals) {
    for (const [id, p] of pendingApprovals) {
      pendingApprovals.delete(id)
      try {
        // A denied permission result the agent SDK accepts as a record.
        p.resolve({ behavior: "deny", message: reason })
      } catch {
        /* defensive — a resolver shape we don't own */
      }
    }
  }
  if (pendingPluginToolCalls) {
    for (const [id, p] of pendingPluginToolCalls) {
      pendingPluginToolCalls.delete(id)
      try {
        // The `{ error }` envelope `plugin-tools.mjs` surfaces as a tool error.
        p.resolve({ error: reason })
      } catch {
        /* defensive — a resolver shape we don't own */
      }
    }
  }
}

/**
 * @param {{
 *   sessionId: string,
 *   firstPrompt: any,
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   log: (level: "info"|"warn"|"error", message: string) => void,
 * }} params
 */
export function dispatchAnthropic({ sessionId, firstPrompt, sendOptions, emit, log }) {
  const inputStream = makeInputStream()
  // Verbose canUseTool tracing (shares the host's COGNIA_SIDECAR_VERBOSE gate).
  // Surfaces as frontend `log` events so a tool-call hang can be diagnosed
  // without stderr access.
  const CANUSETOOL_DEBUG =
    process.env.COGNIA_SIDECAR_VERBOSE === "1" || process.env.COGNIA_SIDECAR_VERBOSE === "true"
  /** @type {Map<string, { resolve: (r: any) => void }>} */
  const pendingApprovals = new Map()
  /**
   * Plugin tool calls awaiting a `plugin_tool_response` from the renderer.
   * Keyed by `toolUseId`. Drained by `claude-host.mjs` when a response
   * arrives over stdin. See `sidecar/builtin-tools/plugin-tools.mjs`.
   * @type {Map<string, { resolve: (r: any) => void }>}
   */
  const pendingPluginToolCalls = new Map()

  const resumeId = sendOptions.resumeSessionId ?? sendOptions.forkFromSessionId
  const isFork = sendOptions.forkFromSessionId != null

  // Shared with the ai-sdk path's permission gate — see dispatch/doom-loop.mjs.
  const doomGuard = createDoomLoopGuard()

  // --- Runtime tool-search (deferred loading) policy -----------------------
  // claude-agent-sdk `alwaysLoad` semantics: when tool search is enabled the
  // bundled CLI defers MCP-server tools behind tool search, keeping only the
  // `alwaysLoad` servers/tools resident. `resolveSendOptions` decides the
  // policy from AppSettings/Character; here we apply it to every in-process
  // server and to the user-configured `mcpServers` map.
  //
  // When tool search is OFF we mark *every* server `alwaysLoad` so all tools
  // stay resident — reproducing the legacy behaviour even if the bundled CLI
  // would otherwise auto-defer once deferred-tool tokens cross its ~10%
  // context threshold. These are sidecar-protocol fields: they are NOT in the
  // `options` allowlist below, so they never reach `query()` verbatim. See
  // `./tool-search-policy.mjs` for the (unit-tested) decision logic.
  const serverAlwaysLoad = makeServerAlwaysLoad(sendOptions)
  const alwaysLoadToolNames = alwaysLoadToolSet(sendOptions)

  // Built-in cognia-tools MCP server (category-toggled).
  const builtinEnabled = sendOptions.builtinTools

  // LSP integration (Phase 1-3): diagnostics-after-edit hook + lsp_* tools.
  // Lazy by design — the resolver and any language server are created only
  // on first use, so non-coding sessions pay nothing. Reuses the
  // vscode-ext-host `LspService` via the shared service-loader; degrades to
  // a no-op when the LSP host is unavailable (mobile / dist not built).
  // The renderer resolves the unified server list (builtin ← user ← project)
  // and serialises it onto `sendOptions.lsp`. We no longer read the
  // `builtinTools.lsp` category directly — `sendOptions.lsp.enabled` already
  // folds it in (`lib/claude/build-options.ts`). `installDir`/`autoInstall`
  // feed the npm-first install ladder (vscode-ext-host lsp-installer).
  // (Construction shared with the ai-sdk path — see lsp-resolver-factory.mjs.)
  const lsp = makeLazyLspResolver({ sendOptions, log })
  const { lspEnabled, lspResolver } = lsp

  // Read-before-write tracking for the coreFiles suite. On this path the
  // suite is registered only via the `coreFilesOnAnthropic` escape hatch
  // (the agent SDK ships native Grep/Read/Edit/Bash), but the tracker is
  // threaded unconditionally so the hatch works without extra plumbing.
  const readTracker = createReadTracker()
  // Per-session background-shell registry (bash run_in_background). Killed at
  // session teardown so no background process outlives the chat (no orphans).
  const bgShells = createBgShellRegistry()

  const builtinServer = buildCogniaToolsServer({
    enabled: builtinEnabled,
    alwaysLoad: serverAlwaysLoad(BUILTIN_SERVER_NAME),
    lspResolver,
    readTracker,
    cwd: sendOptions.cwd,
    dispatchPath: "anthropic",
    bgShells,
    model: sendOptions.model,
    provider: sendOptions.provider ?? "anthropic",
    // Per-tool deadline for read-only built-ins on this channel too (parity with
    // the ai-sdk bridge). `undefined` ⇒ buildCogniaToolsServer's 120s default;
    // `0` disables.
    toolExecutionTimeoutMs: sendOptions.toolExecutionTimeoutMs,
  })
  // Stamp `alwaysLoad` onto user-configured MCP servers per the tool-search
  // policy (the map is keyed by server name, matching alwaysLoadServers).
  const baseUserServers = stampUserServersAlwaysLoad(sendOptions.mcpServers, serverAlwaysLoad)
  const withBuiltins = builtinServer
    ? Object.prototype.hasOwnProperty.call(baseUserServers, BUILTIN_SERVER_NAME)
      ? (() => {
          log(
            "warn",
            `user-defined mcp server '${BUILTIN_SERVER_NAME}' shadows built-in tools — keeping user's`
          )
          return baseUserServers
        })()
      : { ...baseUserServers, [BUILTIN_SERVER_NAME]: builtinServer }
    : { ...baseUserServers }

  // A2UI bridge: always-on in-process MCP server. Interactive surfaces must
  // never be deferred behind tool search, so this server is always-load
  // regardless of the runtime policy (the builder defaults alwaysLoad=true).
  const a2uiServer = buildA2UIBridgeServer({ sessionId, emit, alwaysLoad: true })
  const withA2UI = Object.prototype.hasOwnProperty.call(withBuiltins, A2UI_SERVER_NAME)
    ? (() => {
        log(
          "warn",
          `user-defined mcp server '${A2UI_SERVER_NAME}' shadows built-in a2ui-bridge — keeping user's`
        )
        return withBuiltins
      })()
    : { ...withBuiltins, [A2UI_SERVER_NAME]: a2uiServer }

  // Plugin tools bridge (M2). When the renderer passes a plugin tools
  // manifest, synthesize an in-process MCP server that proxies invocations
  // back over stdio via `plugin_tool_exec` events. The `pendingPluginToolCalls`
  // map is shared with `claude-host.mjs` so the renderer-side response can
  // resolve the in-flight tool call.
  let mergedMcpServers = withA2UI
  if (Array.isArray(sendOptions.pluginTools) && sendOptions.pluginTools.length > 0) {
    const pluginToolsServer = buildPluginToolsServer({
      tools: sendOptions.pluginTools,
      emit,
      sessionId,
      pendingPluginToolCalls,
      alwaysLoad: serverAlwaysLoad(PLUGIN_TOOLS_SERVER_NAME),
      alwaysLoadToolNames,
    })
    if (pluginToolsServer) {
      mergedMcpServers = Object.prototype.hasOwnProperty.call(withA2UI, PLUGIN_TOOLS_SERVER_NAME)
        ? (() => {
            log(
              "warn",
              `user-defined mcp server '${PLUGIN_TOOLS_SERVER_NAME}' shadows plugin-tools — keeping user's`
            )
            return withA2UI
          })()
        : { ...withA2UI, [PLUGIN_TOOLS_SERVER_NAME]: pluginToolsServer }
    }
  }

  // Defence-in-depth: stamp disabled-category tool names onto disallowedTools.
  const disallowed = new Set(sendOptions.disallowedTools ?? [])
  if (builtinEnabled !== undefined) {
    for (const name of namesForDisabledCategories(builtinEnabled)) {
      disallowed.add(name)
    }
  }

  // ADR-0028 — per-`query()` env is the per-session account/proxy isolation
  // mechanism. `sendOptions.env` (built by `lib/claude/build-options.ts`)
  // carries the resolved account env (`CLAUDE_CODE_OAUTH_TOKEN`,
  // `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, …) plus proxy env. The
  // claude-agent-sdk v0.2.111+ overlays this onto the spawned CLI
  // subprocess's environment; an earlier v0.2.113 brief replace-not-overlay
  // regime is also handled correctly by our explicit `process.env` spread
  // below — DO NOT collapse this to `sendOptions.env` alone or essential
  // host vars like PATH will be lost on Windows.
  //
  // NOTE: there is intentionally no `containerSkillIds` / `skills-2025-10-02`
  // beta-header passthrough here. The Claude Agent SDK exposes NO `query()`
  // option to attach Anthropic-managed (uploaded) skill_ids — verified against
  // sdk 0.3.x (`containerSkillIds` is read by no runtime version, `SdkBeta` has
  // no skills value, no `container.skills` request is built). The old header
  // was inert without the attach; the renderer now warns at resolve time
  // instead of silently dropping (see `lib/claude/build-options.ts`).
  const baseEnv = { ...process.env, ...(sendOptions.env ?? {}) }

  // M5 Computer Use — merge `sendOptions.appendHeaders` into
  // ANTHROPIC_DEFAULT_HEADERS. The renderer's `resolveSendOptions` populates
  // `appendHeaders["anthropic-beta"]` (typically `computer-use-2025-11-24`)
  // when the active character has `enableComputerUse === true` and at least
  // one native Anthropic tool is registered. The merging is comma-joined and
  // the per-key prefix matches the existing skills-header pattern.
  if (sendOptions.appendHeaders && typeof sendOptions.appendHeaders === "object") {
    const additions = []
    for (const [key, value] of Object.entries(sendOptions.appendHeaders)) {
      if (typeof key !== "string" || typeof value !== "string") continue
      if (!key || !value) continue
      additions.push(`${key}=${value}`)
    }
    if (additions.length > 0) {
      const existing = baseEnv.ANTHROPIC_DEFAULT_HEADERS
      baseEnv.ANTHROPIC_DEFAULT_HEADERS = existing
        ? `${existing},${additions.join(",")}`
        : additions.join(",")
    }
  }

  // Allowlist construction — only fields listed below reach the SDK. This is
  // intentional: cognia-next sends a few sidecar-protocol-only fields
  // (`builtinTools`, `bareMode`, `debugMode`, `briefMode`, `aliasResolution`,
  // `routingDecision`, `provider`, `providerCredentials`) that the SDK doesn't
  // recognise. They're consumed earlier in `resolveSendOptions` (translated
  // into env / settingSources / appendSystemPrompt / etc.) or in this
  // dispatcher before this object is built (`builtinTools` → `mergedMcpServers`).
  const options = {
    cwd: sendOptions.cwd,
    model: sendOptions.model,
    fallbackModel: sendOptions.fallbackModel,
    // SDK 0.3.x dropped the top-level `appendSystemPrompt` from the public
    // `Options` type. Fold the stable base + dynamic appended sections into the
    // typed `systemPrompt: string | string[]` form (array = separate system
    // blocks, stable→dynamic order) — no reliance on the untyped runtime field.
    systemPrompt: foldSystemPrompt(sendOptions.systemPrompt, sendOptions.appendSystemPrompt),
    allowedTools: sendOptions.allowedTools,
    disallowedTools: disallowed.size > 0 ? [...disallowed] : sendOptions.disallowedTools,
    additionalDirectories: sendOptions.additionalDirectories,
    permissionMode: sendOptions.permissionMode,
    mcpServers: mergedMcpServers,
    maxTurns: sendOptions.maxTurns,
    // Hard USD ceiling for this single invocation. The SDK halts and emits a
    // `result` with subtype `error_max_budget_usd` when crossed. Mapped from the
    // active goal's `maxBudgetUsd` by `resolveSendOptions`.
    maxBudgetUsd: sendOptions.maxBudgetUsd,
    // Deprecated `maxThinkingTokens` → typed `thinking` config (ThinkingEnabled).
    // The ai-sdk path still consumes `sendOptions.maxThinkingTokens` directly,
    // so the translation is localized here to the Anthropic dispatcher.
    thinking: thinkingFromBudget(sendOptions.maxThinkingTokens),
    includePartialMessages: sendOptions.includePartialMessages,
    settingSources: sendOptions.settingSources,
    agents: sendOptions.agents,
    // Run THIS turn's main thread AS the named subagent (its system prompt, tool
    // restrictions, and model) — Claude Code's `@agent` / `--agent`. Set by
    // `resolveSendOptions` from the composer's `@`-mention, and only ever an id
    // already present in `agents` above (membership-guarded there). Undefined is
    // stripped by the pass below, so a normal turn is unaffected.
    agent: sendOptions.agent,
    // Forward subagent text/thinking as parent_tool_use_id-tagged frames so the
    // renderer's SDK-subagent bridge can render rich nested logs (team /
    // workflow-editor). The query options are an explicit whitelist, so this
    // must be passed through here.
    forwardSubagentText: sendOptions.forwardSubagentText,
    strictMcpConfig: sendOptions.strictMcpConfig,
    effort: sendOptions.effort,
    resume: resumeId,
    forkSession: isFork ? true : undefined,
    env: baseEnv,

    // Diagnostics-after-edit feedback loop (Phase 2). Omitted when LSP is
    // disabled — the strip-undefined pass below removes the field.
    hooks: lspEnabled ? buildLspHooks(lspResolver) : undefined,

    canUseTool: (toolName, input, ctx) => {
      // The `ask_user` elicitation tool is the user interaction itself: the
      // renderer's AskUserDialog blocks until the user answers, so it must
      // never surface the generic tool-approval modal. Each call is inherently
      // human-gated (no runaway loop is possible without a human answering),
      // so allow it unconditionally — ahead of even the doom-loop guard.
      if (isAskUserTool(toolName)) {
        return Promise.resolve({ behavior: "allow", updatedInput: input })
      }
      // Doom-loop guard: the Nth identical call must round-trip through the
      // user even when the suppress-list / ruleset would allow it silently.
      const doomed = doomGuard.check(toolName, input) === "ask"
      // ADR-0020 W3 — short-circuit the chat-side approval modal when
      // the renderer has pre-approved this tool for the session. The
      // Rust permission gate runs its own check on every `desktop.*`
      // call, so suppressing here only skips the *redundant* second
      // prompt. Populated by `applyComputerUseTools` from
      // per-session grants when `chatConsentMode === "session-grant"`.
      const suppressList = Array.isArray(sendOptions.suppressApprovalForTools)
        ? sendOptions.suppressApprovalForTools
        : null
      if (!doomed && suppressList && suppressList.includes(toolName)) {
        return Promise.resolve({ behavior: "allow", updatedInput: input })
      }
      // OpenCode-style static ruleset short-circuit (Layer A). Only EXPLICIT
      // allow/deny rules act here; anything else ("ask") falls through to the
      // normal round-trip so the renderer's richer Auto-mode (Layer B) and the
      // manual approval modal still run. Fail-open on any resolver error.
      const ruleset = sendOptions.permissionRuleset
      if (ruleset && !doomed) {
        try {
          const verdict = resolveForToolCall(ruleset, toolName, input)
          if (verdict === "allow") {
            return Promise.resolve({ behavior: "allow", updatedInput: input })
          }
          if (verdict === "deny") {
            return Promise.resolve({
              behavior: "deny",
              message: "denied by permission ruleset",
            })
          }
        } catch {
          // fall through to the approval round-trip
        }
      }
      const requestId = randomUUID()
      // Boundary instrumentation (COGNIA_SIDECAR_VERBOSE=1): the Agent SDK path
      // forces a `canUseTool` round-trip for every gated tool, so when a turn
      // "hangs at the tool call" these three log lines localise the stall —
      // entry (the SDK called us), emit (the request left the sidecar), resolve
      // (the renderer answered). A missing "resolved" line means the round-trip
      // never came back (no dialog / swallowed approval).
      if (CANUSETOOL_DEBUG) {
        log("info", `[canUseTool] enter tool=${toolName} requestId=${requestId}`)
      }
      emit({
        type: "permission_request",
        sessionId,
        requestId,
        toolUseID: ctx.toolUseID,
        toolName,
        input,
        title: ctx.title,
        displayName: ctx.displayName,
        description: ctx.description,
        blockedPath: ctx.blockedPath,
        decisionReason: ctx.decisionReason,
        suggestions: ctx.suggestions,
      })
      if (CANUSETOOL_DEBUG) {
        log(
          "info",
          `[canUseTool] permission_request emitted tool=${toolName} requestId=${requestId}`
        )
      }
      return new Promise((resolve) => {
        const settle = (result) => {
          if (CANUSETOOL_DEBUG) {
            log(
              "info",
              `[canUseTool] resolved tool=${toolName} requestId=${requestId} behavior=${result?.behavior ?? "?"}`
            )
          }
          resolve(result)
        }
        // Stash the original tool input so the host can hand it back as
        // `updatedInput` when the user approves the call unmodified — the SDK
        // requires `updatedInput` to be a record on an allow.
        pendingApprovals.set(requestId, { resolve: settle, input })
        if (ctx.signal) {
          const onAbort = () => {
            if (pendingApprovals.delete(requestId)) {
              settle({ behavior: "deny", message: "aborted" })
            }
          }
          if (ctx.signal.aborted) onAbort()
          else ctx.signal.addEventListener("abort", onAbort, { once: true })
        }
      })
    },
  }

  // Strip undefined/null so the SDK uses its defaults instead of choking on
  // `null.type` lookups.
  for (const k of Object.keys(options)) {
    if (options[k] === undefined || options[k] === null) delete options[k]
  }

  const q = query({ prompt: inputStream.iterable, options })

  const session = {
    q,
    pushUserMessage: (content) =>
      inputStream.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: sessionId,
      }),
    // Manual compaction: the Agent SDK owns compaction and intercepts a
    // `/compact [focus]` user turn (emitting its own `compact_boundary`). We
    // unify the manual entry point by pushing that turn — no bespoke summary.
    requestCompact: (focus) => {
      const trimmed = typeof focus === "string" ? focus.trim() : ""
      session.pushUserMessage(trimmed ? `/compact ${trimmed}` : "/compact")
    },
    closeInput: inputStream.close,
    // Immediate teardown drain for the host's interrupt/close handlers. The SDK
    // `q.interrupt()` doesn't settle `pendingPluginToolCalls`, so without this a
    // closed/crashed renderer would keep the turn alive until the per-call
    // timeout. See `drainPendingRoundTrips`.
    drainPending: (reason) =>
      drainPendingRoundTrips({ pendingApprovals, pendingPluginToolCalls }, reason),
    pendingApprovals,
    pendingPluginToolCalls,
    sendOptions,
  }

  // Push the first turn immediately.
  session.pushUserMessage(firstPrompt)

  // Pipe SDK events to the parent. Captures the SDK-issued session id on the
  // first event that carries one (powers resume continuity).
  let sdkSessionIdSeen = false
  ;(async () => {
    try {
      for await (const evt of q) {
        if (!sdkSessionIdSeen && evt && typeof evt.session_id === "string") {
          sdkSessionIdSeen = true
          emit({
            type: "sdk_session_id",
            sessionId,
            sdkSessionId: evt.session_id,
          })
        }
        emit({ type: "event", sessionId, event: evt })
      }
      emit({ type: "session_ended", sessionId })
    } catch (err) {
      emit({
        type: "session_ended",
        sessionId,
        error: err?.message ?? String(err),
        // Forward the real HTTP status + Retry-After so the renderer classifies
        // the failure and times the breaker cooldown off authoritative data
        // instead of string-matching the message.
        ...extractHttpErrorMeta(err),
      })
    } finally {
      session._ended = true
      // Tear down any per-session LSP servers the resolver started.
      lsp.dispose()
      // Kill any background shells the agent left running this session.
      bgShells.killAll()
    }
  })()

  return session
}
