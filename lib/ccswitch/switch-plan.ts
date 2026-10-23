// Pure switch preview: native SDK changes and external-agent patches.

import type {
  AgentEnvPatch,
  CcswitchAgentId,
  CcswitchProvider,
  SwitchPlan,
  SwitchScope,
} from "@/types/ccswitch"
import {
  CCSWITCH_PROPAGATION_AGENTS,
  canSwitchProvider,
  ccswitchProviderRefId,
  isOfficialClaudeProvider,
} from "./provider"

function envUpdatesForProvider(
  agent: CcswitchAgentId,
  provider: CcswitchProvider
): Array<{ key: string; value: string | null }> {
  switch (agent) {
    case "opencode":
      // OpenCode auth.json keys entries by provider id. We carry the api key
      // under OPENCODE_API_KEY plus an out-of-band `__provider` field (consumed
      // by the Rust writer, never persisted) selecting the entry to patch.
      // opencode reads base URLs from its own opencode.json, not auth.json, so
      // baseUrl is not propagated here.
      return [
        { key: "OPENCODE_API_KEY", value: provider.apiKey?.trim() || null },
        { key: "__provider", value: "anthropic" },
      ]
    case "claude-code":
    default:
      return [
        { key: "ANTHROPIC_AUTH_TOKEN", value: null },
        { key: "ANTHROPIC_API_KEY", value: provider.apiKey?.trim() || null },
        { key: "ANTHROPIC_BASE_URL", value: provider.baseUrl?.trim() || null },
      ]
  }
}

function targetPathFor(agent: CcswitchAgentId): string | null {
  switch (agent) {
    case "claude-code":
      // ~/.claude/settings.json — the env block file, NOT ~/.claude.json
      // (which is the MCP config). The Rust side computes the actual path.
      return "~/.claude/settings.json"
    case "opencode":
      // ~/.local/share/opencode/auth.json (Windows: %LOCALAPPDATA%\opencode\).
      // The Rust side computes the actual OS-specific path; this is the Unix
      // display path shown in the dialog.
      return "~/.local/share/opencode/auth.json"
    default:
      return null
  }
}

function unsupportedReason(agent: CcswitchAgentId): string {
  // The frontend i18n layer will replace this with a translated string;
  // returning the agent id keeps tests readable and gives the i18n hook
  // a stable lookup key.
  return `agent.${agent}.providerEnv.unsupported`
}

/**
 * Build a preview of the switch. Pure — no I/O. The caller is responsible
 * for fetching the current `AppSettings` and passing the relevant fields in
 * via `current`. (Keeping this dependency-free makes it trivial to unit-test
 * and to render dialogs without flickering through async boundaries.)
 */
export function planSwitch(
  provider: CcswitchProvider,
  scope: SwitchScope,
  current: {
    apiKey?: string
    apiBaseUrl?: string
    activeProviderId?: string
    customHeaders?: Record<string, string>
  }
): SwitchPlan {
  const nextActiveId = ccswitchProviderRefId(provider)
  const nextApiKey = provider.apiKey?.trim() || undefined
  const nextBaseUrl = provider.baseUrl?.trim() || undefined
  const useSubscription = isOfficialClaudeProvider(provider)

  // Header additions, edits and removals all require a new SDK process.
  // A subscription switch also restarts because its bearer is read at spawn.
  const beforeHeaders = current.customHeaders ?? {}
  const afterHeaders = provider.customHeaders ?? {}
  const headersNeedRestart =
    Object.keys(beforeHeaders).length !== Object.keys(afterHeaders).length ||
    Object.entries(afterHeaders).some(([key, value]) => beforeHeaders[key] !== value)
  const restart =
    nextApiKey !== current.apiKey ||
    nextBaseUrl !== current.apiBaseUrl ||
    headersNeedRestart ||
    useSubscription

  const agentChanges: AgentEnvPatch[] = scope.agents.map((agentId) => {
    if (!canSwitchProvider(provider) || !CCSWITCH_PROPAGATION_AGENTS.includes(agentId)) {
      return {
        agentId,
        targetPath: null,
        unsupported: true,
        unsupportedReason: unsupportedReason(agentId),
        envUpdates: [],
      }
    }
    return {
      agentId,
      targetPath: targetPathFor(agentId),
      unsupported: false,
      envUpdates: envUpdatesForProvider(agentId, provider),
    }
  })

  return {
    provider,
    scope,
    cogniaChanges: {
      apiKeyBefore: current.apiKey,
      apiKeyAfter: nextApiKey,
      baseUrlBefore: current.apiBaseUrl,
      baseUrlAfter: nextBaseUrl,
      activeProviderIdBefore: current.activeProviderId,
      activeProviderIdAfter: nextActiveId,
      restartSidecar: restart,
      useSubscription,
    },
    agentChanges,
  }
}
