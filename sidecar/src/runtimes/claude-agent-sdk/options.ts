import type { HookMap } from "../../hooks/kernel/types.ts"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { enforceAnthropicToolSurface } from "./tool-surface.ts"
import type { OptionsContext } from "./runtime-types.ts"

import { randomUUID } from "node:crypto"

import { buildSubprocessEnv } from "./subprocess-env.ts"

import { foldSystemPrompt, thinkingFromBudget } from "./system-prompt.ts"
import { createAnthropicCanUseTool } from "../../policy/permission/sdk-can-use-tool.ts"
import {
  enforceAnthropicPermissionChannel,
  type DelegatingSdkOptions,
} from "../../policy/permission/delegated-approval.ts"

import { buildLspHooks } from "../../hooks/lsp-diagnostics.ts"
import { buildAgentHooks, mergeHookMaps } from "../../hooks/agent-hooks.ts"
import { buildLedgerToolHooks } from "./ledger.ts"
import { createNativeHookExecutor } from "../../hooks/native-executor.ts"

import { applyEmbeddedClaudeExecutable } from "./executable.ts"
import {
  applyClaudeAgentSdkOptions,
  buildSdkInteractionCallbacks,
  intersectTrustedWorkspaceRoots,
} from "./sdk-options.ts"
import { sessionStoreFromSendOptions } from "./session-store.ts"

export function buildAnthropicOptions({
  sendOptions,
  sessionId,
  emit,
  log,
  hostRpc,
  mcpStderrSink,
  ledgerGate,
  sdkFallbackModel,
  sdkMaxBudgetUsd,
  pendingApprovals,
  pendingPluginHookCalls,
  doomGuard,
  interruptForLedger,
  surface,
}: OptionsContext) {
  const {
    mergedMcpServers,
    pluginToolNameAliases,
    modelAllowedTools,
    disallowed,
    lspEnabled,
    lspResolver,
  } = surface
  const resumeId = sendOptions.resumeSessionId ?? sendOptions.forkFromSessionId
  const isFork = sendOptions.forkFromSessionId != null
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
  const baseEnv = buildSubprocessEnv(sendOptions)
  // A ledgered envelope must not hide transport retries inside the CLI: each
  // retry is another billed request the ledger never saw.
  if (ledgerGate.active) baseEnv.CLAUDE_CODE_MAX_RETRIES = "0"

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

  const executeNativeHook = createNativeHookExecutor({
    cwd: sendOptions.cwd,
    env: baseEnv,
    model:
      sendOptions.execution?.modelBindings?.primary &&
      sendOptions.execution.modelBindings.primary !== "inherit"
        ? sendOptions.execution.modelBindings.primary
        : sendOptions.model,
    fallbackModel: sdkFallbackModel,
    mcpServers: mergedMcpServers,
    allowedTools: modelAllowedTools,
    maxBudgetUsd: sdkMaxBudgetUsd,
  })

  // Allowlist construction — only fields listed below reach the SDK. This is
  // intentional: cognia-next sends a few sidecar-protocol-only fields
  // (`builtinTools`, `bareMode`, `debugMode`, `briefMode`, `aliasResolution`,
  // `routingDecision`, `provider`, `providerCredentials`) that the SDK doesn't
  // recognise. They're consumed earlier in `resolveSendOptions` (translated
  // into env / settingSources / appendSystemPrompt / etc.) or in this
  // dispatcher before this object is built (`builtinTools` → `mergedMcpServers`).
  let options: Options & Record<string, unknown> = {
    cwd: sendOptions.cwd,
    model:
      sendOptions.execution?.modelBindings?.primary &&
      sendOptions.execution.modelBindings.primary !== "inherit"
        ? sendOptions.execution.modelBindings.primary
        : sendOptions.model,
    fallbackModel: sdkFallbackModel,
    // SDK 0.3.x dropped the top-level `appendSystemPrompt` from the public
    // `Options` type. Fold the stable base + dynamic appended sections into the
    // typed `systemPrompt: string | string[]` form (array = separate system
    // blocks, stable→dynamic order) — no reliance on the untyped runtime field.
    systemPrompt: foldSystemPrompt(sendOptions.systemPrompt, sendOptions.appendSystemPrompt),
    allowedTools: modelAllowedTools,
    disallowedTools: disallowed.size > 0 ? [...disallowed] : sendOptions.disallowedTools,
    additionalDirectories: sendOptions.additionalDirectories,
    permissionMode: sendOptions.permissionMode,
    mcpServers: mergedMcpServers,
    maxTurns: sendOptions.maxTurns,
    // Hard USD ceiling for this single invocation. The SDK halts and emits a
    // `result` with subtype `error_max_budget_usd` when crossed. Mapped from the
    // active goal's `maxBudgetUsd` by `resolveSendOptions`.
    maxBudgetUsd: sdkMaxBudgetUsd,
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

    // Capture the claude-code subprocess stderr (incl. spawned stdio MCP
    // servers' diagnostics) into `mcp_log` events. Wrapped by the sink so a
    // downstream emit failure never faults the SDK's stderr pump.
    stderr: (data) => mcpStderrSink.write(data),

    // Diagnostics-after-edit feedback loop (Phase 2). Omitted when LSP is
    // disabled — the strip-undefined pass below removes the field.
    // SDK-native hooks: the LSP diagnostics-after-edit hook (Phase 2) merged
    // with the user's settings.json lifecycle hooks (`sendOptions.hooks`, injected
    // HOST-side after the trust gate). Both are `Partial<Record<HookEvent,
    // HookCallbackMatcher[]>>`; `mergeHookMaps` concatenates per event. Returns
    // undefined when neither contributes, so the strip pass omits the key.
    hooks: mergeHookMaps(
      lspEnabled ? buildLspHooks(lspResolver) : undefined,
      buildAgentHooks(sendOptions.hooks, {
        emit: (frame) => emit({ ...frame }),
        emitAudit: (frame) => emit({ ...frame }),
        log,
        sessionId,
        cwd: sendOptions.cwd,
        provider: "claude",
        // Which agent this turn belongs to, for the `agents` group selector.
        // The SDK cannot supply it (cognia never launches with `--agent`), so
        // the renderer names the turn and it rides in on sendOptions.
        agentKind: sendOptions.agentKind,
        agentRef: sendOptions.agentRef,
        // Session's plugin-tools manifest: resolves `mcp__cognia-plugin-tools__*`
        // names back to their pluginId for the `tool_provenance` payload field.
        pluginTools: sendOptions.pluginTools,
        // Per-server `declared_by` locators for `mcp` tool_provenance — same
        // keys as the `mcpServers` wire map.
        mcpDeclaredBy: sendOptions.mcpDeclaredBy,
        executeNativeHandler: executeNativeHook,
        pendingPluginHookCalls,
        newId: () => randomUUID(),
      }),
      buildLedgerToolHooks({
        gate: ledgerGate,
        onRefused: () => interruptForLedger(),
      }) as unknown as HookMap
    ) as Options["hooks"],

    canUseTool: createAnthropicCanUseTool({
      sendOptions,
      sessionId,
      emit,
      log,
      pendingApprovals,
      pluginToolNameAliases,
      doomGuard,
    }) as Options["canUseTool"],
  }

  // Nested `SendOptions.claudeAgentSdk` — the 29 SDK options the flat allowlist
  // above never covered. Applied AFTER the allowlist so the documented
  // precedence (nested > flat > SDK default) holds, and BEFORE the strip pass so
  // an explicit `undefined` in the block still means "use the SDK default".
  const hostCanUseTool = options.canUseTool as ReturnType<typeof createAnthropicCanUseTool>
  const sdkOverlay = applyClaudeAgentSdkOptions(options, sendOptions.claudeAgentSdk, {
    resume: resumeId,
    forkSession: isFork,
    permissionMode: sendOptions.permissionMode,
    bypassConfirmed: sendOptions.bypassPermissionsConfirmed === true,
    // Local skills/plugins are provider-visible code/instructions. A root must
    // be both active for this send and explicitly granted by Workspace Trust;
    // naming cwd/additionalDirectories alone never grants content trust.
    trustedWorkspaceRoots: intersectTrustedWorkspaceRoots(sendOptions.trustedWorkspaceRoots, [
      sendOptions.cwd,
      ...(sendOptions.additionalDirectories ?? []),
    ]),
    cwd: sendOptions.cwd,
    activeWorkspaceRoots: [sendOptions.cwd, ...(sendOptions.additionalDirectories ?? [])],
  })
  options.systemPrompt = foldSystemPrompt(
    sendOptions.claudeAgentSdk?.systemPrompt ?? sendOptions.systemPrompt,
    sendOptions.appendSystemPrompt
  )
  Object.assign(
    options,
    buildSdkInteractionCallbacks(sendOptions.claudeAgentSdk, (toolName, input, ctx) =>
      hostCanUseTool(toolName, input, ctx)
    )
  )
  for (const warning of sdkOverlay.warnings) {
    // Surfaced, not swallowed: every one of these is a setting that did not take
    // effect, and the caller cannot tell that from behaviour alone.
    log("warn", `[claudeAgentSdk] ${warning}`)
    emit({ type: "sdk_option_warning", sessionId, message: warning })
  }

  // The session mirror is a LIVE object with methods, so it cannot ride the
  // JSON wire — the nested block carries a descriptor and the real store is
  // built here, against the Rust host over `host_rpc`. Assigned after the
  // overlay because the overlay copies serialisable fields only, and before the
  // strip pass so a `null` from a host without the channel is removed rather
  // than handed to the SDK.
  const sessionStore = sessionStoreFromSendOptions(sendOptions, { hostRpc, log })
  if (sessionStore) {
    options.sessionStore = sessionStore
    // `batched` is the SDK default; only forward an explicit choice.
    const flush = sendOptions.claudeAgentSdk?.sessionStore?.flush
    if (flush) options.sessionStoreFlush = flush
  }

  options = enforceAnthropicPermissionChannel(
    options as unknown as DelegatingSdkOptions,
    sendOptions,
    pluginToolNameAliases
  ) as unknown as Options & Record<string, unknown>
  options = enforceAnthropicToolSurface(options, sendOptions)
  options = applyEmbeddedClaudeExecutable(options)

  // Strip undefined/null so the SDK uses its defaults instead of choking on
  // `null.type` lookups.
  for (const k of Object.keys(options)) {
    if (options[k] === undefined || options[k] === null) delete options[k]
  }

  return options
}
