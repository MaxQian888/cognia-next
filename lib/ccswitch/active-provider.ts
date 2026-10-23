// Active-provider matching and drift projection; never writes credentials.

import { getSettings } from "@/lib/db/settings"
import type { ActiveProviderState, CcswitchAgentId, CcswitchProvider } from "@/types/ccswitch"
import { canSwitchProvider, ccswitchProviderRefId } from "./provider"

/**
 * Probe each surface for which CCSwitch provider it is currently using.
 * Comparison is by `(apiKey, baseUrl)` tuple — provider records with the
 * same key+URL pair are considered equivalent regardless of name.
 *
 * The `agentReaders` parameter is injected so callers (and tests) can plug
 * in their own probes; the default uses no I/O for now (claude-code's env
 * block lives outside cognia-next's existing `read_agent_config`, and we
 * don't want this function to silently start hitting disk on every render).
 * The Settings → CCSwitch overview tab passes a real reader that calls
 * `read_claude_user_settings` to populate the `claude-code` slot.
 */
export async function detectActive(
  providers: CcswitchProvider[],
  options: {
    agentReaders?: Partial<
      Record<CcswitchAgentId, () => Promise<{ apiKey?: string; baseUrl?: string } | null>>
    >
  } = {}
): Promise<ActiveProviderState> {
  const settings = await getSettings()
  const candidates = providers.filter(canSwitchProvider)
  const matched =
    candidates.find(
      (provider) =>
        ccswitchProviderRefId(provider) === settings.activeProviderId &&
        matchProvider([provider], { apiKey: settings.apiKey, baseUrl: settings.apiBaseUrl })
    ) ?? matchProvider(candidates, { apiKey: settings.apiKey, baseUrl: settings.apiBaseUrl })
  const cognia = matched ? ccswitchProviderRefId(matched) : undefined

  const agents: Partial<Record<CcswitchAgentId, string | undefined>> = {}
  const readers = options.agentReaders ?? {}
  for (const agentId of Object.keys(readers) as CcswitchAgentId[]) {
    const reader = readers[agentId]
    if (!reader) continue
    try {
      const env = await reader()
      if (env) {
        const match = matchProvider(
          providers.filter((provider) =>
            agentId === "claude-code"
              ? provider.kind === "claude" || provider.kind === "claude-desktop"
              : provider.kind === agentId
          ),
          env
        )
        agents[agentId] = match ? ccswitchProviderRefId(match) : undefined
      } else {
        agents[agentId] = undefined
      }
    } catch {
      agents[agentId] = undefined
    }
  }

  const drift = detectDrift(cognia, agents)
  return { cognia, agents, drift }
}

function matchProvider(
  providers: CcswitchProvider[],
  env: { apiKey?: string; baseUrl?: string }
): CcswitchProvider | undefined {
  const k = (env.apiKey ?? "").trim()
  const normalizeUrl = (url: string | undefined) => (url ?? "").trim().replace(/\/+$/, "")
  const u = normalizeUrl(env.baseUrl)
  if (!k && !u) return undefined
  return providers.find((p) => (p.apiKey ?? "").trim() === k && normalizeUrl(p.baseUrl) === u)
}

function detectDrift(
  cognia: string | undefined,
  agents: Partial<Record<CcswitchAgentId, string | undefined>>
): boolean {
  for (const id of Object.values(agents)) {
    if (id === undefined) continue
    if (cognia === undefined) return true
    if (id !== cognia) return true
  }
  return false
}
